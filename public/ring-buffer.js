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
  const writeFrame = Atomics.load(stateView, STATE.WRITE_FRAME);
  const framesPerBlock = Atomics.load(stateView, STATE.FRAMES_PER_BLOCK) || fallbackFramesPerBlock;
  const readFrame = Math.max(0, writeFrame - framesPerBlock * targetBlocks);
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
  let readFrame = Atomics.load(stateView, STATE.READ_FRAME);
  const writeFrame = Atomics.load(stateView, STATE.WRITE_FRAME);
  const clampedLeft = Math.min(leftChannel, channels - 1);
  const clampedRight = Math.min(rightChannel, channels - 1);
  let underrun = false;

  for (let index = 0; index < leftOut.length; index += 1) {
    if (readFrame >= writeFrame) {
      leftOut[index] = 0;
      rightOut[index] = 0;
      underrun = true;
      continue;
    }

    const ringFrame = readFrame % capacityFrames;
    const offset = ringFrame * channels;
    leftOut[index] = sampleView[offset + clampedLeft] || 0;
    rightOut[index] = sampleView[offset + clampedRight] || 0;
    readFrame += 1;
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
