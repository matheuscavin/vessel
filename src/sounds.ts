import type { SoundName } from "./types";
/** Short tones, synthesized rather than bundled: nothing to download, nothing to cache. */
const voices: Record<
  SoundName,
  { at: number; hz: number; wave: OscillatorType }[]
> = {
  Chime: [
    { at: 0, hz: 880, wave: "sine" },
    { at: 0.11, hz: 1318.5, wave: "sine" },
  ],
  Ping: [{ at: 0, hz: 1244.5, wave: "triangle" }],
  Knock: [
    { at: 0, hz: 196, wave: "square" },
    { at: 0.09, hz: 146.8, wave: "square" },
  ],
};
export const soundNames = Object.keys(voices) as SoundName[];
let context: AudioContext | null = null;
/** Percent in, gain out, with headroom so two voices never clip together. */
function level(volume: number) {
  return (Math.min(100, Math.max(0, volume)) / 100) * 0.3;
}
export function playSound(name: SoundName, volume: number) {
  const gain = level(volume);
  if (!gain) return;
  try {
    context ??= new AudioContext();
    // Browsers start the context suspended until a gesture; settings previews resume it.
    void context.resume();
    const now = context.currentTime;
    for (const voice of voices[name] ?? voices.Chime) {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = voice.wave;
      oscillator.frequency.value = voice.hz;
      envelope.gain.setValueAtTime(0.0001, now + voice.at);
      envelope.gain.exponentialRampToValueAtTime(gain, now + voice.at + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + voice.at + 0.26);
      oscillator.connect(envelope).connect(context.destination);
      oscillator.start(now + voice.at);
      oscillator.stop(now + voice.at + 0.28);
    }
  } catch {
    /* An unavailable audio device must never interrupt the terminal. */
  }
}
