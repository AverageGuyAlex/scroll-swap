/* Generates the two alarm WAVs into assets/. Run once with:
     node tools/make-alarm-audio.js
   Kept in the repo so the sounds can be regenerated or retuned rather than
   being opaque binaries nobody can change.

   WAV rather than MP3 because Node can write it with no dependencies. Both
   files are small enough that it does not matter, and /assets/* is cached for
   a year. */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'assets');

function encodeWav(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // PCM chunk size
  header.writeUInt16LE(1, 20);         // format: PCM
  header.writeUInt16LE(1, 22);         // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);         // block align
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/* Two notes, A5 then D6, each with an exponential decay. Pleasant rather than
   startling — this fires while you are concentrating. */
function chime() {
  const rate = 22050;
  const noteSeconds = 0.6;
  const notes = [880, 1174.7];
  const samples = [];
  for (const freq of notes) {
    const count = Math.floor(rate * noteSeconds);
    for (let i = 0; i < count; i++) {
      const t = i / rate;
      const envelope = Math.exp(-4 * t);
      // A quiet third harmonic stops it sounding like a bare test tone.
      const tone = Math.sin(2 * Math.PI * freq * t)
                 + 0.2 * Math.sin(2 * Math.PI * freq * 3 * t);
      samples.push(0.45 * envelope * tone);
    }
  }
  return { samples, rate };
}

/* Near-inaudible, NOT digital silence: iOS optimises true silence away and
   stops treating the page as playing media, which is the whole point of this
   file. Very low amplitude noise survives that. */
function keepAlive() {
  const rate = 8000;
  const seconds = 1;
  const count = rate * seconds;
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push((Math.random() * 2 - 1) * 0.0008);
  }
  // Fade the first and last 100 samples so the loop point has no click.
  for (let i = 0; i < 100; i++) {
    samples[i] *= i / 100;
    samples[count - 1 - i] *= i / 100;
  }
  return { samples, rate };
}

for (const [name, gen] of [['alarm-chime', chime], ['alarm-keepalive', keepAlive]]) {
  const { samples, rate } = gen();
  const buf = encodeWav(samples, rate);
  const file = path.join(OUT_DIR, name + '.wav');
  fs.writeFileSync(file, buf);
  console.log(`  wrote ${name}.wav  ${(buf.length / 1024).toFixed(1)} KB  ${rate} Hz  ${(samples.length / rate).toFixed(2)}s`);
}
