import { useState, useEffect, useRef, useCallback } from "react";
import { Hands, HAND_CONNECTIONS, VERSION } from "@mediapipe/hands";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";

import {
  Landmark,
  BASE_CHORDS,
  FINGER_NAMES,
  MAX_PITCH_OFFSET,
  PITCH_CONTROL_AREA,
  SUSTAIN_TIME_SECONDS,
} from "./utils/constants";

import { midiToFreq, isFingerUp } from "./utils/lib";

import * as Tone from "tone";

// --- Constants and Helpers (Keep as before) ---
const synth = new Tone.PolySynth(Tone.Synth, {
  oscillator: { type: "fmtriangle" },
  envelope: { attack: 0.01, decay: 0.1, sustain: 0.4, release: 1.4 },
  volume: -6,
}).toDestination();

function AirPiano() {
  const webcamRef = useRef(null);
  const canvasRef = useRef(null);
  const handsRef = useRef(null);
  const animationFrameIdRef = useRef(null);

  const [isLoading, setIsLoading] = useState(true);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [pitchOffsetState, setPitchOffsetState] = useState(0);
  const [isAudioStarted, setIsAudioStarted] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const pitchOffsetRef = useRef(0);
  const activeNotesRef = useRef({});
  const prevFingerStatesRef = useRef({});
  const currentFramePitchRef = useRef(0);

  // --- Pitch Calculation ---
  const calculatePitchOffset = useCallback((landmarks) => {
    if (!landmarks || landmarks.length === 0) return 0;
    const wrist = landmarks[Landmark.WRIST];
    if (!wrist) return 0;
    const canvasHeight = canvasRef.current?.height || window.innerHeight;
    const wristY = wrist.y * canvasHeight;
    const minY = PITCH_CONTROL_AREA.MIN_Y * canvasHeight;
    const maxY = PITCH_CONTROL_AREA.MAX_Y * canvasHeight;
    const controlRange = maxY - minY;
    if (controlRange <= 0) return 0;
    const clampedY = Math.max(minY, Math.min(maxY, wristY));
    const normalizedPosition = (clampedY - minY) / controlRange;
    const offset = Math.round(
      (1 - normalizedPosition) * (2 * MAX_PITCH_OFFSET) - MAX_PITCH_OFFSET,
    );
    return offset;
  }, []);

  // --- Chord Playback ---
  const playChord = useCallback(
    (chordNotes, handIndex, fingerName, currentAudioPitchOffset) => {
      console.log(
        `Attempting to play ${fingerName} with offset ${currentAudioPitchOffset}`,
      );
      const chordId = `${handIndex}_${fingerName}`;
      if (activeNotesRef.current[chordId]?.timeoutId) {
        clearTimeout(activeNotesRef.current[chordId].timeoutId);
      }
      const pitchedFreqs = chordNotes
        .map((note) => midiToFreq(note + currentAudioPitchOffset))
        .filter((freq) => freq > 0 && freq < 20000);
      console.log("Pitched Frequencies:", pitchedFreqs);
      if (pitchedFreqs.length > 0) {
        if (activeNotesRef.current[chordId]?.notes) {
          synth.triggerRelease(
            activeNotesRef.current[chordId].notes,
            Tone.now(),
          );
        }
        synth.triggerAttack(pitchedFreqs, Tone.now());
        console.log("--- Triggered Attack ---");
        activeNotesRef.current[chordId] = {
          notes: pitchedFreqs,
          timeoutId: null,
        };
      } else {
        console.log("No valid frequencies to play.");
      }
    },
    [],
  );

  const scheduleStopChord = useCallback((handIndex, fingerName) => {
    const chordId = `${handIndex}_${fingerName}`;
    const activeChord = activeNotesRef.current[chordId];
    if (activeChord && activeChord.notes && !activeChord.timeoutId) {
      const timeoutId = setTimeout(() => {
        if (activeNotesRef.current[chordId]?.notes === activeChord.notes) {
          console.log(`Stopping ${fingerName} (Sustained)`);
          synth.triggerRelease(activeChord.notes, Tone.now());
          delete activeNotesRef.current[chordId];
        }
      }, SUSTAIN_TIME_SECONDS * 1000);
      if (activeNotesRef.current[chordId]) {
        activeNotesRef.current[chordId].timeoutId = timeoutId;
      }
    }
  }, []);

  const stopAllNotes = useCallback(() => {
    console.log("Stopping all notes (callback)...");
    Object.values(activeNotesRef.current).forEach((activeChord) => {
      if (activeChord) {
        if (activeChord.timeoutId) clearTimeout(activeChord.timeoutId);
        if (activeChord.notes)
          synth.triggerRelease(activeChord.notes, Tone.now());
      }
    });
    activeNotesRef.current = {};
    prevFingerStatesRef.current = {};
  }, []);

  // --- Drawing (Uses state for display) ---
  const drawPitchInfo = useCallback((ctx, canvas, currentDisplayOffset) => {
    const width = canvas.width;
    const height = canvas.height;
    ctx.fillStyle = "rgba(0, 255, 0, 0.8)";
    ctx.font = "20px Arial";
    ctx.textAlign = "left";
    ctx.fillText(
      `Pitch: ${currentDisplayOffset >= 0 ? "+" : ""}${currentDisplayOffset} st`,
      15,
      35,
    );
    const gaugeWidth = 20;
    const gaugeHeight = Math.min(200, height * 0.4);
    const gaugeX = width - gaugeWidth - 30;
    const gaugeY = (height - gaugeHeight) / 2;
    ctx.fillStyle = "rgba(100, 100, 100, 0.5)";
    ctx.fillRect(gaugeX, gaugeY, gaugeWidth, gaugeHeight);
    const normalizedOffset =
      (currentDisplayOffset + MAX_PITCH_OFFSET) / (2 * MAX_PITCH_OFFSET);
    const markerY = gaugeY + (1 - normalizedOffset) * gaugeHeight;
    ctx.fillStyle = "rgba(0, 255, 0, 0.9)";
    ctx.fillRect(gaugeX - 5, markerY - 3, gaugeWidth + 10, 6);
    const neutralY = gaugeY + 0.5 * gaugeHeight;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gaugeX, neutralY);
    ctx.lineTo(gaugeX + gaugeWidth, neutralY);
    ctx.stroke();
  }, []);

  // --- MediaPipe Processing Logic ---
  const onResults = useCallback(
    (results) => {
      const audioPitchOffset = pitchOffsetRef.current;
      const canvasCtx = canvasRef.current?.getContext("2d");
      const canvasElement = canvasRef.current;
      if (!canvasCtx || !canvasElement) return;

      try {
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
        if (results.image) {
          canvasCtx.drawImage(
            results.image,
            0,
            0,
            canvasElement.width,
            canvasElement.height,
          );
        }

        let calculatedPitchOffset = 0;

        if (
          results.multiHandLandmarks &&
          results.multiHandLandmarks.length > 0 &&
          results.multiHandedness
        ) {
          calculatedPitchOffset = calculatePitchOffset(
            results.multiHandLandmarks[0],
          );

          pitchOffsetRef.current = calculatedPitchOffset;
          setPitchOffsetState(calculatedPitchOffset);
          currentFramePitchRef.current = calculatedPitchOffset;

          results.multiHandLandmarks.forEach((landmarks, handIndex) => {
            const handInfo = results.multiHandedness[handIndex];
            const handType = handInfo?.label || "Unknown";
            if (!landmarks) return;

            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {
              color: handType === "Right" ? "#00FF00" : "#FF0000",
              lineWidth: 5,
            });
            drawLandmarks(canvasCtx, landmarks, {
              color: handType === "Right" ? "#FF0000" : "#00FF00",
              lineWidth: 2,
              radius: 3,
            });

            FINGER_NAMES.forEach((fingerName) => {
              const chordId = `${handIndex}_${fingerName}`;
              const currentFingerState = isFingerUp(
                landmarks,
                fingerName,
                handType,
              );
              const prevFingerState =
                prevFingerStatesRef.current[chordId] || false;

              if (currentFingerState && !prevFingerState) {
                if (BASE_CHORDS[fingerName] && isAudioStarted) {
                  console.log(`Finger UP: ${fingerName}. Calling playChord.`);
                  playChord(
                    BASE_CHORDS[fingerName],
                    handIndex,
                    fingerName,
                    audioPitchOffset,
                  );
                } else if (!isAudioStarted) {
                  console.log(
                    `Finger UP: ${fingerName}, but audio not started.`,
                  );
                }
              } else if (!currentFingerState && prevFingerState) {
                if (BASE_CHORDS[fingerName]) {
                  scheduleStopChord(handIndex, fingerName);
                }
              }
              prevFingerStatesRef.current[chordId] = currentFingerState;
            });
          });
        } else {
          if (Object.keys(activeNotesRef.current).length > 0) {
            stopAllNotes();
          }
          if (pitchOffsetRef.current !== 0) {
            pitchOffsetRef.current = 0;
            setPitchOffsetState(0);
          }
          currentFramePitchRef.current = 0;
        }

        drawPitchInfo(canvasCtx, canvasElement, currentFramePitchRef.current);

        canvasCtx.restore();
      } catch (error) {
        console.error("!!!!!! Error within onResults !!!!!!!!!!:", error);
        if (canvasCtx) canvasCtx.restore();
      }
    },
    [
      calculatePitchOffset,
      isAudioStarted,
      playChord,
      scheduleStopChord,
      stopAllNotes,
      drawPitchInfo,
    ],
  );

  // --- Initialization Effect (Setup MediaPipe/Camera) ---
  useEffect(() => {
    console.log("Running Setup Effect (Mounting)...");
    setErrorMessage("");
    let handsInstance = null;
    let isActive = true;

    try {
      handsInstance = new Hands({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${VERSION}/${file}`,
      });
      handsInstance.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.6,
      });
      handsInstance.onResults(onResults);
      handsRef.current = handsInstance;
    } catch (error) {
      console.error("Error initializing MediaPipe Hands:", error);
      setErrorMessage("Failed to initialize hand tracking. Please try again.");
      setIsLoading(false);
      return;
    }

    const setupCamera = async () => {
      console.log("Setting up camera...");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error("getUserMedia not supported.");
        if (isActive) {
          setErrorMessage(
            "Webcam access (getUserMedia) is not supported by your browser.",
          );
          setIsLoading(false);
        }
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
        });
        if (!isActive || !webcamRef.current) {
          console.log(
            "Component unmounted or ref missing during camera setup.",
          );
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        webcamRef.current.srcObject = stream;
        await new Promise((resolve, reject) => {
          if (!webcamRef.current) {
            reject(new Error("Webcam ref became null"));
            return;
          }
          webcamRef.current.onloadedmetadata = resolve;
          webcamRef.current.onerror = (e) =>
            reject(new Error("Video metadata loading error"));
        });
        if (!isActive || !canvasRef.current || !webcamRef.current) {
          console.log(
            "Component unmounted or ref missing after metadata loaded.",
          );
          if (webcamRef.current?.srcObject) {
            webcamRef.current.srcObject
              .getTracks()
              .forEach((track) => track.stop());
          }
          return;
        }
        const videoWidth = webcamRef.current.videoWidth;
        const videoHeight = webcamRef.current.videoHeight;
        canvasRef.current.width = videoWidth;
        canvasRef.current.height = videoHeight;
        console.log(`Canvas size set to: ${videoWidth}x${videoHeight}`);
        if (isActive) {
          setIsCameraReady(true);
          setIsLoading(false);
          console.log("Camera ready.");
        }
      } catch (error) {
        console.error("Error accessing webcam:", error);
        if (!isActive) return;
        if (
          error.name === "NotAllowedError" ||
          error.name === "PermissionDeniedError"
        ) {
          setErrorMessage(
            "Camera permission denied. Please allow camera access and refresh.",
          );
        } else if (error.message?.includes("Video metadata loading error")) {
          setErrorMessage("Error loading video stream.");
        } else {
          setErrorMessage(
            "Could not access webcam. Ensure it's connected and not in use.",
          );
        }
        setIsLoading(false);
      }
    };

    if (isActive) {
      setupCamera();
    }

    return () => {
      console.log("Cleaning up Setup Effect (Unmounting)...");
      isActive = false;
      cancelAnimationFrame(animationFrameIdRef.current);
      const instanceToClose = handsRef.current || handsInstance;
      if (instanceToClose) {
        instanceToClose
          .close()
          .catch((err) => console.error("Error closing Hands:", err));
        handsRef.current = null;
      }
      stopAllNotes();
      if (webcamRef.current && webcamRef.current.srcObject) {
        webcamRef.current.srcObject
          .getTracks()
          .forEach((track) => track.stop());
        webcamRef.current.srcObject = null;
      }
      setIsCameraReady(false);
      setIsLoading(true);
      pitchOffsetRef.current = 0;
    };
  }, [onResults, stopAllNotes]);

  // --- Animation Loop Effect ---
  useEffect(() => {
    let lastTime = 0;
    const frameInterval = 1000 / 30;
    let isActive = true;
    const predictWebcam = async (currentTime) => {
      if (!isActive) return;
      if (
        !handsRef.current ||
        !webcamRef.current ||
        !isCameraReady ||
        webcamRef.current.readyState < 2 ||
        webcamRef.current.videoWidth === 0
      ) {
        animationFrameIdRef.current = requestAnimationFrame(predictWebcam);
        return;
      }
      const deltaTime = currentTime - lastTime;
      if (deltaTime >= frameInterval) {
        lastTime = currentTime;
        try {
          if (handsRef.current && webcamRef.current) {
            await handsRef.current.send({ image: webcamRef.current });
          }
        } catch (error) {
          console.error("Error during hands.send:", error);
        }
      }
      animationFrameIdRef.current = requestAnimationFrame(predictWebcam);
    };
    if (isCameraReady) {
      console.log("Starting prediction loop...");
      animationFrameIdRef.current = requestAnimationFrame(predictWebcam);
    }
    return () => {
      console.log("Stopping prediction loop (Anim cleanup)...");
      isActive = false;
      cancelAnimationFrame(animationFrameIdRef.current);
    };
  }, [isCameraReady]);

  // --- Handle Audio Context Start ---
  const handleStartAudio = async () => {
    setErrorMessage("");
    if (!isAudioStarted) {
      try {
        console.log("Attempting to start Tone AudioContext...");
        await Tone.start();
        console.log("AudioContext started successfully!");
        setIsAudioStarted(true);
      } catch (error) {
        console.error("Failed to start AudioContext:", error);
        setErrorMessage(
          "Could not enable audio. User interaction might be required again.",
        );
        setIsAudioStarted(false);
      }
    } else {
      console.log("AudioContext already started.");
    }
  };

  // --- JSX with Tailwind CSS Styling ---
  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-black text-white overflow-hidden">
      {/* Header section with title and created by - centered at the top */}
      <div className="absolute top-0 left-0 w-full flex justify-center items-center p-4 z-10 bg-black bg-opacity-50">
        <div className="text-center">
          <h1 className="text-xl md:text-4xl font-bold text-white">
            Web Air Piano
          </h1>
          <p className="text-xs text-gray-300">Created by Smriti</p>
        </div>
      </div>

      {/* Status Messages */}
      <div className="absolute top-20 left-0 w-full flex justify-center z-10">
        {isLoading && (
          <p className="text-xl bg-black bg-opacity-60 px-4 py-2 rounded-lg">
            Loading Models and Camera...
          </p>
        )}
        {errorMessage && (
          <p className="text-xl bg-red-900 bg-opacity-60 px-4 py-2 rounded-lg">
            {errorMessage}
          </p>
        )}
        {!isLoading && !isCameraReady && !errorMessage && (
          <p className="text-xl bg-black bg-opacity-60 px-4 py-2 rounded-lg">
            Waiting for camera access...
          </p>
        )}
      </div>

      {/* Enable Audio Button - centered below the title */}
      {!isLoading && isCameraReady && !isAudioStarted && (
        <div className="absolute top-24 left-0 w-full flex justify-center z-20">
          <button
            onClick={handleStartAudio}
            className="px-4 py-2 bg-green-600 text-xs hover:bg-green-500 text-white font-bold rounded-lg shadow-lg transition-all duration-300 transform hover:scale-105"
          >
            Enable Audio
          </button>
        </div>
      )}

      {/* Audio Status Indicator - centered */}
      {isAudioStarted && (
        <div className="absolute top-24 left-0 w-full flex justify-center z-20">
          <div className="px-3 py-1 bg-green-700 text-white text-xs rounded-lg flex items-center">
            <div className="w-3 h-3 rounded-full bg-green-400 mr-2 animate-pulse text-xs"></div>
            Audio Enabled
          </div>
        </div>
      )}

      {/* Hidden video element */}
      <video ref={webcamRef} autoPlay playsInline className="hidden"></video>

      {/* Canvas - Fullscreen */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full object-cover z-0"
      ></canvas>

      {/* Instructions overlay */}
      <div className="absolute bottom-4 left-0 w-full flex justify-center z-10">
        <div className="bg-black bg-opacity-60 px-4 py-2 rounded-lg text-xs max-w-md text-center">
          <p>
            Raise your fingers to play notes. Move your wrist up and down to
            change pitch.
          </p>
        </div>
      </div>
    </div>
  );
}

export default AirPiano;
