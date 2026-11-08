export function pcmBlock({ frameStart = 0n, frameCount = 2, channels = 2, reserved = 0,
  samples = [0.25, -0.5, 0.75, -1] } = {}) {
  const buffer = new ArrayBuffer(16 + samples.length * 4);
  const view = new DataView(buffer);
  view.setBigUint64(0, frameStart, true);
  view.setUint32(8, frameCount, true);
  view.setUint16(12, channels, true);
  view.setUint16(14, reserved, true);
  samples.forEach((sample, index) => view.setFloat32(16 + index * 4, sample, true));
  return buffer;
}
