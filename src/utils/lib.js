import { Landmark } from "./constants";

export function midiToFreq(midiNote) {
  return Math.pow(2, (midiNote - 69) / 12) * 440;
}

export function isFingerUp(landmarks, fingerName, handType) {
  if (!landmarks) return false;
  const tipIndex =
    Landmark[`${fingerName.toUpperCase()}_FINGER_TIP`] || Landmark.THUMB_TIP;
  const pipIndex = Landmark[`${fingerName.toUpperCase()}_FINGER_PIP`];
  const mcpIndex =
    Landmark[`${fingerName.toUpperCase()}_FINGER_MCP`] || Landmark.THUMB_MCP;
  const tip = landmarks[tipIndex];
  const pip = landmarks[pipIndex];
  const mcp = landmarks[mcpIndex];
  if (!tip || !mcp) return false;
  if (fingerName === "thumb") {
    const wrist = landmarks[Landmark.WRIST];
    if (!wrist) return false;
    if (handType === "Right") {
      return tip.x < mcp.x;
    } else {
      return tip.x > mcp.x;
    }
  } else {
    if (!pip) return false;
    return tip.y < pip.y;
  }
}
