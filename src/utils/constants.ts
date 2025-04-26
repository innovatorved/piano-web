export const Landmark = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_FINGER_MCP: 5,
  INDEX_FINGER_PIP: 6,
  INDEX_FINGER_TIP: 8,
  MIDDLE_FINGER_MCP: 9,
  MIDDLE_FINGER_PIP: 10,
  MIDDLE_FINGER_TIP: 12,
  RING_FINGER_MCP: 13,
  RING_FINGER_PIP: 14,
  RING_FINGER_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
};
export const BASE_CHORDS = {
  thumb: [62, 66, 69],
  index: [64, 67, 71],
  middle: [66, 69, 73],
  ring: [67, 71, 74],
  pinky: [69, 73, 76],
};
export const FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"];
export const MAX_PITCH_OFFSET = 12;
export const PITCH_CONTROL_AREA = { MIN_Y: 0.2, MAX_Y: 0.8 };
export const SUSTAIN_TIME_SECONDS = 0.8;
