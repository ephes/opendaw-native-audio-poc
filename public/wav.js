const RIFF_HEADER_BYTES = 44;
const FLOAT32_BYTES = 4;
const WAVE_FORMAT_IEEE_FLOAT = 3;

export function createMonoFloat32WavBlob({ sampleRate, totalFrames, channelParts }) {
  const dataBytes = totalFrames * FLOAT32_BYTES;
  const riffBytes = RIFF_HEADER_BYTES - 8 + dataBytes;
  if (riffBytes > 0xffff_ffff) {
    throw new Error("Selected-channel WAV is larger than the 4 GiB RIFF limit");
  }

  const header = new ArrayBuffer(RIFF_HEADER_BYTES);
  const view = new DataView(header);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, riffBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_IEEE_FLOAT, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * FLOAT32_BYTES, true);
  view.setUint16(32, FLOAT32_BYTES, true);
  view.setUint16(34, 32, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  return new Blob([header, ...channelParts], { type: "audio/wav" });
}

export function extractChannel(samples, channelIndex, channelCount, frameCount) {
  const channelSamples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    channelSamples[frame] = samples[frame * channelCount + channelIndex] ?? 0;
  }
  return channelSamples;
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}
