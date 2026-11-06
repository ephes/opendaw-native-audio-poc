export const STATE_BYTES = 256;
export const STATE_INTS = 64;
export const RING_BUFFER_BYTES_PER_SAMPLE = 4;
export const DEFAULT_FRAMES_PER_BLOCK = 960;

export const STATE = {
  WRITE_FRAME: 0,
  READ_FRAME: 1,
  OVERFLOW_COUNT: 2,
  UNDERRUN_COUNT: 3,
  CHANNELS: 4,
  CAPACITY_FRAMES: 5,
  CONNECTED: 6,
  SAMPLE_RATE: 7,
  FRAMES_PER_BLOCK: 8,
  RECEIVED_BLOCKS: 9,
  RESERVED_WRITE_FRAME: 10,
};

export function createRingBufferViews(
  sharedBuffer,
  stateView = new Int32Array(sharedBuffer, 0, STATE_INTS),
) {
  const channels = Atomics.load(stateView, STATE.CHANNELS);
  const capacityFrames = Atomics.load(stateView, STATE.CAPACITY_FRAMES);
  const sampleView = new Float32Array(
    sharedBuffer,
    STATE_BYTES,
    capacityFrames * channels,
  );

  return { stateView, sampleView, channels, capacityFrames };
}

export function alignReadCursor(
  stateView,
  { targetBlocks = 3, fallbackFramesPerBlock = DEFAULT_FRAMES_PER_BLOCK } = {},
) {
  const writeFrame = Atomics.load(stateView, STATE.WRITE_FRAME) >>> 0;
  const framesPerBlock = Atomics.load(stateView, STATE.FRAMES_PER_BLOCK) || fallbackFramesPerBlock;
  const capacity = Atomics.load(stateView, STATE.CAPACITY_FRAMES);
  const currentRead = Atomics.load(stateView, STATE.READ_FRAME) >>> 0;
  const behind = Math.min((writeFrame - currentRead) >>> 0, capacity, framesPerBlock * targetBlocks);
  const readFrame = (writeFrame - behind) >>> 0;
  Atomics.store(stateView, STATE.READ_FRAME, readFrame);
  return readFrame;
}

export function readStereoFromRingBuffer(
  stateView,
  sampleView,
  leftOut,
  rightOut,
  leftChannel = 0,
  rightChannel = 1,
) {
  const channels = Atomics.load(stateView, STATE.CHANNELS);
  const capacityFrames = Atomics.load(stateView, STATE.CAPACITY_FRAMES);
  const originalRead = Atomics.load(stateView, STATE.READ_FRAME) >>> 0;
  let readFrame = originalRead;
  const writeFrame = Atomics.load(stateView, STATE.WRITE_FRAME) >>> 0;
  const clampedLeft = Math.min(leftChannel, channels - 1);
  const clampedRight = Math.min(rightChannel, channels - 1);
  let underrun = false;

  // Only the consumer owns READ_FRAME. Catch up after overflow without
  // allowing the producer to race a consumer cursor commit.
  if (((writeFrame - readFrame) >>> 0) > capacityFrames) {
    readFrame = (writeFrame - capacityFrames) >>> 0;
  }

  const firstRead = readFrame;
  for (let index = 0; index < leftOut.length; index += 1) {
    if (readFrame === writeFrame) {
      leftOut[index] = 0;
      rightOut[index] = 0;
      underrun = true;
      continue;
    }

    const ringFrame = readFrame % capacityFrames;
    const offset = ringFrame * channels;
    leftOut[index] = sampleView[offset + clampedLeft] || 0;
    rightOut[index] = sampleView[offset + clampedRight] || 0;
    readFrame = (readFrame + 1) >>> 0;
  }

  // The producer reserves its write range before touching PCM. Only
  // overlapping writes invalidate copied audio; unrelated writes must not
  // insert silence or delay cursor progress. Never retry on the realtime thread.
  const reservedEnd = Atomics.load(stateView, STATE.RESERVED_WRITE_FRAME) >>> 0;
  if (((reservedEnd - firstRead) >>> 0) > capacityFrames) {
    leftOut.fill(0);
    rightOut.fill(0);
    readFrame = originalRead;
    underrun = true;
  }

  if (underrun) {
    Atomics.add(stateView, STATE.UNDERRUN_COUNT, 1);
  }
  Atomics.store(stateView, STATE.READ_FRAME, readFrame);

  return {
    readFrame,
    writeFrame,
    underrun,
  };
}

export function writePcmToRingBuffer(stateView, sampleView, samples, frameCount) {
  const channels = Atomics.load(stateView, STATE.CHANNELS);
  const capacityFrames = Atomics.load(stateView, STATE.CAPACITY_FRAMES);
  const writeFrame = Atomics.load(stateView, STATE.WRITE_FRAME) >>> 0;
  const readFrame = Atomics.load(stateView, STATE.READ_FRAME) >>> 0;
  const available = (writeFrame - readFrame) >>> 0;

  if (available + frameCount > capacityFrames) {
    Atomics.add(stateView, STATE.OVERFLOW_COUNT, 1);
  }

  Atomics.store(stateView, STATE.RESERVED_WRITE_FRAME, writeFrame + frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const ringFrame = ((writeFrame + frame) >>> 0) % capacityFrames;
    const ringOffset = ringFrame * channels;
    const inputOffset = frame * channels;
    sampleView.set(samples.subarray(inputOffset, inputOffset + channels), ringOffset);
  }

  Atomics.store(stateView, STATE.WRITE_FRAME, writeFrame + frameCount);
}
