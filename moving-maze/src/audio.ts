import { MUSIC_FADE_SEC, MUSIC_VOLUME } from './config.ts';

type Ctor = typeof AudioContext;

// A 小调五声音阶：随机取音也一定协和，不会出现刺耳的半音冲突
const SCALE = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
const PAD_CHORD = [110.0, 130.81, 164.81];
const LOOKAHEAD_SEC = 2.5;
const SCHEDULER_MS = 800;

/**
 * Web Audio 合成的低音量氛围背景音乐：持续低音垫 + 极轻气流噪声 + 稀疏五声音阶音符。
 * 全部程序化生成，不依赖任何外部音频素材，天然无限循环。
 * 只在用户首次开始游戏后创建 AudioContext，遵守浏览器自动播放限制；
 * 创建失败只关闭音乐，不影响游戏运行。
 */
export class Music {
  enabled: boolean;
  available = true;
  /** 已创建的 AudioContext 数量：换关/返回主页面都不应该让它增长 */
  createdCount = 0;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private scheduler: number | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private nextNoteTime = 0;
  private gestured = false;
  private hidden = false;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** 首次用户手势（快速开始 / 选择难度）后调用；幂等，绝不叠加播放器 */
  onUserStart(): void {
    this.gestured = true;
    if (!this.enabled) return;
    this.ensureStarted();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.fadeTo(0);
      return;
    }
    if (this.gestured) this.ensureStarted();
    if (this.ctx && this.ctx.state === 'suspended' && !this.hidden) void this.ctx.resume().catch(() => undefined);
    this.fadeTo(MUSIC_VOLUME);
  }

  /** 页面隐藏时暂停，恢复后遵守原来的开关状态 */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    const ctx = this.ctx;
    if (!ctx) return;
    if (hidden) {
      this.stopScheduler();
      if (ctx.state === 'running') void ctx.suspend().catch(() => undefined);
      return;
    }
    if (this.enabled && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    this.startScheduler();
  }

  dispose(): void {
    this.stopScheduler();
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // 已停止的节点会抛错，忽略
      }
    }
    this.sources.length = 0;
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  private fadeTo(value: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(value, now + MUSIC_FADE_SEC);
  }

  private ensureStarted(): void {
    if (this.ctx !== null || !this.available) return;
    try {
      const Ctor: Ctor | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
      if (!Ctor) {
        this.available = false;
        return;
      }
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);

      this.buildPad(ctx, master);
      this.buildAir(ctx, master);

      this.ctx = ctx;
      this.master = master;
      this.createdCount++;
      this.nextNoteTime = ctx.currentTime + 1;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      this.fadeTo(MUSIC_VOLUME);
      this.startScheduler();
    } catch {
      this.available = false;
      this.ctx = null;
      this.master = null;
    }
  }

  private buildPad(ctx: AudioContext, master: GainNode): void {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.6;
    filter.connect(master);

    // 滤波频率缓慢起伏，避免完全静止的嗡鸣
    const sweep = ctx.createOscillator();
    const sweepGain = ctx.createGain();
    sweep.frequency.value = 0.045;
    sweepGain.gain.value = 150;
    sweep.connect(sweepGain);
    sweepGain.connect(filter.frequency);
    sweep.start();
    this.sources.push(sweep);

    for (const freq of PAD_CHORD) {
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.detune.value = detune;
        const gain = ctx.createGain();
        gain.gain.value = 0.16;

        // 呼吸式音量 LFO
        const breath = ctx.createOscillator();
        const breathGain = ctx.createGain();
        breath.frequency.value = 0.06 + freq / 4000;
        breathGain.gain.value = 0.07;
        breath.connect(breathGain);
        breathGain.connect(gain.gain);
        breath.start();

        osc.connect(gain);
        gain.connect(filter);
        osc.start();
        this.sources.push(osc, breath);
      }
    }
  }

  private buildAir(ctx: AudioContext, master: GainNode): void {
    const seconds = 3;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      // 一阶低通后的噪声，听起来像远处的风而不是白噪
      const white = Math.random() * 2 - 1;
      last = last * 0.94 + white * 0.06;
      data[i] = last * 3;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 520;
    band.Q.value = 0.4;
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    source.connect(band);
    band.connect(gain);
    gain.connect(master);
    source.start();
    this.sources.push(source);
  }

  private startScheduler(): void {
    if (this.scheduler !== null || this.ctx === null) return;
    this.scheduler = window.setInterval(() => this.scheduleNotes(), SCHEDULER_MS);
  }

  private stopScheduler(): void {
    if (this.scheduler === null) return;
    window.clearInterval(this.scheduler);
    this.scheduler = null;
  }

  private scheduleNotes(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    while (this.nextNoteTime < ctx.currentTime + LOOKAHEAD_SEC) {
      this.playBell(ctx, master, this.nextNoteTime);
      this.nextNoteTime += 3.2 + Math.random() * 4.5;
    }
  }

  private playBell(ctx: AudioContext, master: AudioNode, at: number): void {
    const freq = SCALE[Math.floor(Math.random() * SCALE.length)] * (Math.random() < 0.35 ? 0.5 : 1);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.5, at + 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0008, at + 4.2);
    gain.connect(master);

    for (const detune of [0, 4]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(gain);
      osc.start(at);
      osc.stop(at + 4.4);
    }
  }
}
