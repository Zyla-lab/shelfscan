// Camera access + hands-free auto-capture.
//
// Auto-capture idea: sample a tiny grayscale thumbnail of the video ~8x per second.
//  * "motion"  = difference between consecutive samples (hands moving, bottle being placed)
//  * "scene"   = difference between the current still frame and a reference
// When the view has been still for `holdMs`, compare it to the empty background and to the
// last captured frame. Different from both => a new container is in view => capture.
// Back to looking like the background => the spot is empty, ready for the next one.

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
  }

  async start() {
    this.stop();
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play().catch(() => {});
    await new Promise((r) => (this.video.readyState >= 2 ? r() : this.video.addEventListener('loadeddata', r, { once: true })));
    try {
      const caps = this.track.getCapabilities?.() || {};
      const adv = {};
      if (caps.focusMode?.includes('continuous')) adv.focusMode = 'continuous';
      if (caps.exposureMode?.includes('continuous')) adv.exposureMode = 'continuous';
      if (caps.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode = 'continuous';
      if (Object.keys(adv).length) await this.track.applyConstraints({ advanced: [adv] });
    } catch {
      /* optional */
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
  }

  get running() {
    return !!this.track && this.track.readyState === 'live';
  }

  get torchSupported() {
    try {
      return !!this.track?.getCapabilities?.().torch;
    } catch {
      return false;
    }
  }

  async setTorch(on) {
    if (!this.torchSupported) return false;
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
    return true;
  }

  /** Grab the current frame at full resolution. */
  grab() {
    const v = this.video;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return c;
  }
}

const SW = 48;
const SH = 36;

export class AutoCapture {
  /**
   * @param {HTMLVideoElement} video
   * @param {{onState:(s:string, info:object)=>void, onTrigger:()=>void}} handlers
   */
  constructor(video, handlers) {
    this.video = video;
    this.h = handlers;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SW;
    this.canvas.height = SH;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.timer = null;
    this.enabled = true;
    this.setSensitivity(2);
    this.holdMs = 800;
    this.reset();
  }

  setSensitivity(level) {
    // level 1 = less sensitive (needs bigger change), 3 = very sensitive
    const scene = { 1: 0.085, 2: 0.06, 3: 0.04 }[level] ?? 0.06;
    this.sceneThresh = scene;
    this.motionThresh = { 1: 0.03, 2: 0.022, 3: 0.016 }[level] ?? 0.022;
  }

  reset() {
    this.prev = null;
    this.background = null;
    this.lastCaptured = null;
    this.stillSince = 0;
    this.bigMotion = false;
    this.state = 'init';
    this.paused = 0;
  }

  resetBackground() {
    this.background = null;
    this.lastCaptured = null;
    this.stillSince = 0;
  }

  /** Mark the current view as "already captured" (e.g. after a manual shot). */
  markCaptured() {
    this.lastCaptured = this.sample();
    this.bigMotion = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 120);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  pauseFor(ms) {
    this.paused = performance.now() + ms;
  }

  sample() {
    const v = this.video;
    if (!v.videoWidth) return null;
    // central 80% of the frame: ignores fingers at the very edges
    const sx = v.videoWidth * 0.1;
    const sy = v.videoHeight * 0.1;
    this.ctx.drawImage(v, sx, sy, v.videoWidth * 0.8, v.videoHeight * 0.8, 0, 0, SW, SH);
    const d = this.ctx.getImageData(0, 0, SW, SH).data;
    const g = new Float32Array(SW * SH);
    let sum = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      g[j] = y;
      sum += y;
    }
    // remove global brightness so auto-exposure drift doesn't look like a change
    const mean = sum / g.length;
    for (let j = 0; j < g.length; j++) g[j] -= mean;
    return g;
  }

  static diff(a, b) {
    if (!a || !b) return 1;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length / 255;
  }

  /** Like diff(), but tolerant of the object being nudged a few pixels in any direction. */
  static shiftedDiff(a, b, max = 3) {
    if (!a || !b) return 1;
    let best = Infinity;
    for (let dy = -max; dy <= max; dy++) {
      for (let dx = -max; dx <= max; dx++) {
        let s = 0;
        let n = 0;
        for (let y = Math.max(0, dy); y < SH + Math.min(0, dy); y++) {
          const ra = y * SW;
          const rb = (y - dy) * SW;
          for (let x = Math.max(0, dx); x < SW + Math.min(0, dx); x++) {
            s += Math.abs(a[ra + x] - b[rb + x - dx]);
            n++;
          }
        }
        best = Math.min(best, s / n / 255);
      }
    }
    return best;
  }

  tick() {
    if (!this.enabled || document.hidden) return;
    const now = performance.now();
    if (now < this.paused) return;
    const cur = this.sample();
    if (!cur) return;
    const motion = AutoCapture.diff(cur, this.prev);
    this.prev = cur;

    if (motion > this.motionThresh) {
      // a hand moving through the view (not just a nudge) => a swap is possible
      if (motion > this.motionThresh * 2.5) this.bigMotion = true;
      this.stillSince = 0;
      this.emit('moving', { progress: 0 });
      return;
    }
    if (!this.stillSince) this.stillSince = now;
    const held = now - this.stillSince;
    const progress = Math.min(1, held / this.holdMs);

    if (!this.background) {
      if (progress >= 1) {
        this.background = cur;
        this.emit('ready', { progress: 0 });
      } else this.emit('calibrating', { progress });
      return;
    }

    const vsBg = AutoCapture.diff(cur, this.background);
    if (vsBg < this.sceneThresh) {
      // empty spot; slowly adapt background to lighting changes
      for (let i = 0; i < cur.length; i++) this.background[i] = this.background[i] * 0.9 + cur[i] * 0.1;
      this.lastCaptured = null;
      this.emit('ready', { progress: 0 });
      return;
    }

    const vsLast = AutoCapture.shiftedDiff(cur, this.lastCaptured);
    // Same bottle still there? After a big hand movement, accept a smaller difference so two
    // similar-looking bottles swapped directly (without emptying the spot) are still caught.
    const sameThresh = this.bigMotion ? this.sceneThresh * 0.5 : this.sceneThresh;
    if (this.lastCaptured && vsLast < sameThresh) {
      this.bigMotion = false;
      this.emit('captured-waiting', { progress: 0 });
      return;
    }

    if (progress < 1) {
      this.emit('holding', { progress });
      return;
    }
    this.lastCaptured = cur;
    this.stillSince = 0;
    this.bigMotion = false;
    this.emit('capturing', { progress: 1 });
    this.h.onTrigger();
  }

  emit(state, info) {
    this.state = state;
    this.h.onState(state, info);
  }
}
