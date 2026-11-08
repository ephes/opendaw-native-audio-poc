export const PCM_BLOCK_HEADER_BYTES = 16;
export const PCM_BYTES_PER_SAMPLE = 4;

export function decodePcmBlock(buffer, { expectedChannels } = {}) {
  if (buffer.byteLength < PCM_BLOCK_HEADER_BYTES) {
    return {
      ok: false,
      kind: "too-small",
      message: `PCM block too small: ${buffer.byteLength} bytes`,
    };
  }

  const view = new DataView(buffer);
  const cursor = view.getBigUint64(0, true);
  const frameCount = view.getUint32(8, true);
  const channels = view.getUint16(12, true);
  const reserved = view.getUint16(14, true);
  if (frameCount < 1 || frameCount > 65536 || channels < 1 || channels > 64) {
    return {
      ok: false,
      kind: "invalid-geometry",
      message: "PCM block geometry requires 1–65536 frames and 1–64 channels",
    };
  }
  if (reserved !== 0) {
    return {
      ok: false,
      kind: "unsupported-reserved",
      message: "PCM block reserved header must be zero",
    };
  }
  const maxFrame = BigInt(Number.MAX_SAFE_INTEGER);
  if (cursor > maxFrame || cursor + BigInt(frameCount) > maxFrame) {
    return {
      ok: false,
      kind: "unsafe-frame-index",
      message: "PCM block cursor and exclusive end must be safe integers",
    };
  }
  const frameStart = Number(cursor);
  const sampleCount = frameCount * channels;
  const expectedBytes = PCM_BLOCK_HEADER_BYTES + sampleCount * PCM_BYTES_PER_SAMPLE;

  if (buffer.byteLength !== expectedBytes) {
    return {
      ok: false,
      kind: "byte-length-mismatch",
      frameStart,
      frameCount,
      channels,
      reserved,
      expectedBytes,
      actualBytes: buffer.byteLength,
      message: `PCM block byte length mismatch: expected ${expectedBytes}, got ${buffer.byteLength}`,
    };
  }

  if (expectedChannels !== undefined && channels !== expectedChannels) {
    return {
      ok: false,
      kind: "channel-mismatch",
      frameStart,
      frameCount,
      channels,
      reserved,
      expectedChannels,
      actualChannels: channels,
      message: `PCM block channel mismatch: expected ${expectedChannels}, got ${channels}`,
    };
  }

  const samples = new Float32Array(buffer, PCM_BLOCK_HEADER_BYTES, sampleCount);
  const dataBytes = new Uint8Array(buffer, PCM_BLOCK_HEADER_BYTES, samples.byteLength);

  return {
    ok: true,
    frameStart,
    frameCount,
    channels,
    reserved,
    samples,
    dataBytes,
  };
}
