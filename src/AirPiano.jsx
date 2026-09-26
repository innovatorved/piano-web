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

// --- Constants and Synth ---
const synth = new Tone.PolySynth(Tone.Synth, {
  oscillator: { type: "fmtriangle" },
  envelope: { attack: 0.01, decay: 0.1, sustain: 0.4, release: 1.4 },
  volume: -6,
}).toDestination();

const CHORD_META = {
  thumb: { name: "D Maj", notes: "D4 · F#4 · A4", finger: "Thumb" },
  index: { name: "E Min", notes: "E4 · G4 · B4", finger: "Index" },
  middle: { name: "F# Min", notes: "F#4 · A4 · C#5", finger: "Middle" },
  ring: { name: "G Maj", notes: "G4 · B4 · D5", finger: "Ring" },
  pinky: { name: "A Maj", notes: "A4 · C#5 · E5", finger: "Pinky" },
};

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function formatFileSize(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

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
  const [userMicStream, setUserMicStream] = useState(null);
  const [pianoStream, setPianoStream] = useState(null);
  const [micError, setMicError] = useState(null);
  const [errorMessages, setErrorMessages] = useState({});
  const [isRecording, setIsRecording] = useState(false);
  const [recordingError, setRecordingError] = useState(null);
  const [videoBlob, setVideoBlob] = useState(null);
  const [finalAudioStream, setFinalAudioStream] = useState(null);

  // Studio UI state
  const [handsDetected, setHandsDetected] = useState(0);
  const [volume, setVolume] = useState(-6);
  const [recordingTime, setRecordingTime] = useState(0);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      return document.documentElement.getAttribute("data-theme") || "dark";
    }
    return "dark";
  });
  const [activeFingers, setActiveFingers] = useState({
    thumb: false,
    index: false,
    middle: false,
    ring: false,
    pinky: false,
  });

  const pitchOffsetRef = useRef(0);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const canvasStreamRef = useRef(null);
  const pianoAudioStreamRef = useRef(null);
  const micStreamRef = useRef(null);
  const combinedAudioStreamRef = useRef(null);
  const finalAVStreamRef = useRef(null);
  const activeNotesRef = useRef({});
  const prevFingerStatesRef = useRef({});
  const currentFramePitchRef = useRef(0);

  // Timer for recording duration
  useEffect(() => {
    let interval = null;
    if (isRecording) {
      setRecordingTime(0);
      interval = setInterval(() => {
        setRecordingTime((t) => t + 1);
      }, 1000);
    } else {
      clearInterval(interval);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute(
        "content",
        nextTheme === "dark" ? "#111213" : "#fbfbfb",
      );
    }
  };

  const handleVolumeChange = (e) => {
    const val = Number(e.target.value);
    setVolume(val);
    if (synth) {
      synth.volume.value = val;
    }
  };

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
      const chordId = `${handIndex}_${fingerName}`;
      if (activeNotesRef.current[chordId]?.timeoutId) {
        clearTimeout(activeNotesRef.current[chordId].timeoutId);
      }
      const pitchedFreqs = chordNotes
        .map((note) => midiToFreq(note + currentAudioPitchOffset))
        .filter((freq) => freq > 0 && freq < 20000);
      if (pitchedFreqs.length > 0) {
        if (activeNotesRef.current[chordId]?.notes) {
          synth.triggerRelease(
            activeNotesRef.current[chordId].notes,
            Tone.now(),
          );
        }
        synth.triggerAttack(pitchedFreqs, Tone.now());
        activeNotesRef.current[chordId] = {
          notes: pitchedFreqs,
          timeoutId: null,
        };
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

  const triggerManualChord = (fingerName) => {
    if (!isAudioStarted) {
      handleStartAudio();
      return;
    }
    setActiveFingers((prev) => ({ ...prev, [fingerName]: true }));
    playChord(BASE_CHORDS[fingerName], 0, fingerName, pitchOffsetRef.current);
    setTimeout(() => {
      scheduleStopChord(0, fingerName);
      setActiveFingers((prev) => ({ ...prev, [fingerName]: false }));
    }, 400);
  };

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

        // Render webcam video feed
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
        const currentActiveMap = {
          thumb: false,
          index: false,
          middle: false,
          ring: false,
          pinky: false,
        };

        if (
          results.multiHandLandmarks &&
          results.multiHandLandmarks.length > 0 &&
          results.multiHandedness
        ) {
          setHandsDetected(results.multiHandLandmarks.length);
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

            // Design system connectors: Sleek engineered lines with clean opacity
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {
              color:
                handType === "Right"
                  ? "rgba(62, 123, 250, 0.7)"
                  : "rgba(110, 162, 255, 0.7)",
              lineWidth: 3,
            });

            // Subtle joint dots
            drawLandmarks(canvasCtx, landmarks, {
              color: "#ffffff",
              lineWidth: 1,
              radius: 2.5,
            });

            // Fingertip nodes & chord note visualization
            FINGER_NAMES.forEach((fingerName) => {
              const chordId = `${handIndex}_${fingerName}`;
              const currentFingerState = isFingerUp(
                landmarks,
                fingerName,
                handType,
              );
              const prevFingerState =
                prevFingerStatesRef.current[chordId] || false;

              if (currentFingerState) {
                currentActiveMap[fingerName] = true;
              }

              // Tip landmark position for drawing
              const tipIndex =
                Landmark[`${fingerName.toUpperCase()}_FINGER_TIP`] ||
                Landmark.THUMB_TIP;
              const tipLandmark = landmarks[tipIndex];

              if (tipLandmark) {
                const tipX = tipLandmark.x * canvasElement.width;
                const tipY = tipLandmark.y * canvasElement.height;

                if (currentFingerState) {
                  // Active glowing ripple
                  canvasCtx.beginPath();
                  canvasCtx.arc(tipX, tipY, 12, 0, 2 * Math.PI);
                  canvasCtx.fillStyle = "rgba(78, 208, 138, 0.35)";
                  canvasCtx.fill();

                  // Active emerald node
                  canvasCtx.beginPath();
                  canvasCtx.arc(tipX, tipY, 6, 0, 2 * Math.PI);
                  canvasCtx.fillStyle = "#4ed08a";
                  canvasCtx.fill();
                  canvasCtx.lineWidth = 2;
                  canvasCtx.strokeStyle = "#ffffff";
                  canvasCtx.stroke();

                  // Crisp chord badge tag above fingertip
                  const label = CHORD_META[fingerName]?.name || fingerName;
                  canvasCtx.font =
                    "600 11px Inter, -apple-system, sans-serif";
                  const textMetrics = canvasCtx.measureText(label);
                  const badgeW = textMetrics.width + 12;
                  const badgeH = 18;
                  const badgeX = tipX - badgeW / 2;
                  const badgeY = tipY - 26;

                  canvasCtx.fillStyle = "rgba(17, 18, 19, 0.9)";
                  canvasCtx.beginPath();
                  if (canvasCtx.roundRect) {
                    canvasCtx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
                  } else {
                    canvasCtx.rect(badgeX, badgeY, badgeW, badgeH);
                  }
                  canvasCtx.fill();
                  canvasCtx.strokeStyle = "rgba(78, 208, 138, 0.6)";
                  canvasCtx.lineWidth = 1;
                  canvasCtx.stroke();

                  canvasCtx.fillStyle = "#f2f4f7";
                  canvasCtx.textAlign = "center";
                  canvasCtx.textBaseline = "middle";
                  canvasCtx.fillText(label, tipX, badgeY + badgeH / 2);
                } else {
                  // Inactive subtle node
                  canvasCtx.beginPath();
                  canvasCtx.arc(tipX, tipY, 4, 0, 2 * Math.PI);
                  canvasCtx.fillStyle = "rgba(62, 123, 250, 0.9)";
                  canvasCtx.fill();
                }
              }

              // Sound triggering
              if (currentFingerState && !prevFingerState) {
                if (BASE_CHORDS[fingerName] && isAudioStarted) {
                  playChord(
                    BASE_CHORDS[fingerName],
                    handIndex,
                    fingerName,
                    audioPitchOffset,
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

          setActiveFingers(currentActiveMap);
        } else {
          setHandsDetected(0);
          setActiveFingers(currentActiveMap);
          if (Object.keys(activeNotesRef.current).length > 0) {
            stopAllNotes();
          }
          if (pitchOffsetRef.current !== 0) {
            pitchOffsetRef.current = 0;
            setPitchOffsetState(0);
          }
          currentFramePitchRef.current = 0;
        }

        canvasCtx.restore();
      } catch (error) {
        console.error("Error within onResults:", error);
        if (canvasCtx) canvasCtx.restore();
      }
    },
    [
      calculatePitchOffset,
      isAudioStarted,
      playChord,
      scheduleStopChord,
      stopAllNotes,
    ],
  );

  // --- Initialization Effect (Setup MediaPipe/Camera) ---
  useEffect(() => {
    setErrorMessage("");

    if (typeof window.MediaRecorder === "undefined") {
      const mediaRecorderSupportError =
        "Video recording is not supported by your browser.";
      setErrorMessage(mediaRecorderSupportError);
      setErrorMessages((prev) => ({
        ...prev,
        mediaRecorder: mediaRecorderSupportError,
      }));
      setIsLoading(false);
    }

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
      setErrorMessage("Failed to initialize hand tracking.");
      setIsLoading(false);
      return;
    }

    const setupCamera = async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (isActive) {
          setErrorMessage(
            "Webcam access is not supported by your browser.",
          );
          setIsLoading(false);
        }
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (!isActive || !webcamRef.current) {
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
          webcamRef.current.onerror = () =>
            reject(new Error("Video metadata loading error"));
        });
        if (!isActive || !canvasRef.current || !webcamRef.current) {
          if (webcamRef.current?.srcObject) {
            webcamRef.current.srcObject
              .getTracks()
              .forEach((track) => track.stop());
          }
          return;
        }
        const videoWidth = webcamRef.current.videoWidth || 640;
        const videoHeight = webcamRef.current.videoHeight || 480;
        canvasRef.current.width = videoWidth;
        canvasRef.current.height = videoHeight;

        if (canvasRef.current.captureStream) {
          canvasStreamRef.current = canvasRef.current.captureStream(30);
        } else {
          setErrorMessages((prev) => ({
            ...prev,
            canvas: "Canvas stream capture not supported.",
          }));
        }

        if (isActive) {
          setIsCameraReady(true);
          setIsLoading(false);
        }
      } catch (error) {
        console.error("Error accessing webcam:", error);
        if (!isActive) return;
        if (
          error.name === "NotAllowedError" ||
          error.name === "PermissionDeniedError"
        ) {
          setErrorMessage(
            "Camera permission denied. Please allow camera access.",
          );
        } else {
          setErrorMessage(
            "Could not access webcam. Ensure it is connected and enabled.",
          );
        }
        setIsLoading(false);
      }
    };

    if (isActive) {
      setupCamera();
    }

    return () => {
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
      animationFrameIdRef.current = requestAnimationFrame(predictWebcam);
    }
    return () => {
      isActive = false;
      cancelAnimationFrame(animationFrameIdRef.current);
    };
  }, [isCameraReady]);

  // --- Handle Audio Context Start ---
  const handleStartAudio = async () => {
    setErrorMessage("");
    if (!isAudioStarted) {
      try {
        await Tone.start();
        if (Tone.context && Tone.context.createMediaStreamDestination) {
          const pianoDestNode = Tone.context.createMediaStreamDestination();
          Tone.getDestination().connect(pianoDestNode);
          pianoAudioStreamRef.current = pianoDestNode.stream;
          setPianoStream(pianoDestNode.stream);
        }
        setIsAudioStarted(true);
      } catch (error) {
        console.error("Failed to start AudioContext:", error);
        setErrorMessage(
          "Could not enable audio. User interaction required.",
        );
        setIsAudioStarted(false);
      }
    }
  };

  const stopMicrophoneCapture = () => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
      setUserMicStream(null);
      setMicError(null);
      setErrorMessages((prev) => ({ ...prev, microphone: "Disabled" }));
    }
  };

  const startMicrophoneCapture = async () => {
    setMicError(null);
    setErrorMessages((prev) => ({ ...prev, microphone: null }));
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicError("Microphone not supported by browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      micStreamRef.current = stream;
      setUserMicStream(stream);
    } catch (error) {
      console.error("Error accessing microphone:", error);
      if (
        error.name === "NotAllowedError" ||
        error.name === "PermissionDeniedError"
      ) {
        setMicError("Microphone permission denied.");
      } else {
        setMicError("Could not access microphone.");
      }
      setUserMicStream(null);
    }
  };

  // --- Combined Audio Stream Preparation ---
  const prepareFinalAudioStream = useCallback(() => {
    const currentPianoStream = pianoAudioStreamRef.current;
    const currentMicStream = micStreamRef.current;
    let finalStream = null;

    if (
      currentPianoStream &&
      currentMicStream &&
      currentPianoStream.getAudioTracks().length > 0 &&
      currentMicStream.getAudioTracks().length > 0
    ) {
      try {
        const audioContext = Tone.context;
        const pianoSource =
          audioContext.createMediaStreamSource(currentPianoStream);
        const micSource =
          audioContext.createMediaStreamSource(currentMicStream);
        const combinedDestination = audioContext.createMediaStreamDestination();

        pianoSource.connect(combinedDestination);
        micSource.connect(combinedDestination);

        finalStream = combinedDestination.stream;
      } catch (error) {
        console.error("Error combining audio streams:", error);
        if (
          currentPianoStream &&
          currentPianoStream.getAudioTracks().length > 0
        ) {
          finalStream = currentPianoStream;
        }
      }
    } else if (
      currentPianoStream &&
      currentPianoStream.getAudioTracks().length > 0
    ) {
      finalStream = currentPianoStream;
    } else if (
      currentMicStream &&
      currentMicStream.getAudioTracks().length > 0
    ) {
      finalStream = currentMicStream;
    }

    combinedAudioStreamRef.current = finalStream;
    setFinalAudioStream(finalStream);
  }, []);

  useEffect(() => {
    prepareFinalAudioStream();
  }, [pianoStream, userMicStream, prepareFinalAudioStream]);

  // --- Final A/V Stream Preparation ---
  const prepareFinalAVStream = useCallback(() => {
    const currentCanvasStream = canvasStreamRef.current;
    const currentCombinedAudioStream = combinedAudioStreamRef.current;
    let newAVStream = null;

    const hasVideo =
      currentCanvasStream && currentCanvasStream.getVideoTracks().length > 0;
    const hasAudio =
      currentCombinedAudioStream &&
      currentCombinedAudioStream.getAudioTracks().length > 0;

    if (hasVideo && hasAudio) {
      try {
        const videoTrack = currentCanvasStream.getVideoTracks()[0];
        const audioTracks = currentCombinedAudioStream.getAudioTracks();
        newAVStream = new MediaStream([videoTrack, ...audioTracks]);
        finalAVStreamRef.current = newAVStream;
        setErrorMessages((prev) => ({ ...prev, avStream: null }));
      } catch (error) {
        console.error("Error creating final A/V stream:", error);
        finalAVStreamRef.current = null;
        setErrorMessages((prev) => ({
          ...prev,
          avStream: "Error creating A/V stream.",
        }));
      }
    } else {
      finalAVStreamRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (isCameraReady && finalAudioStream) {
      prepareFinalAVStream();
    } else {
      finalAVStreamRef.current = null;
    }
  }, [isCameraReady, finalAudioStream, prepareFinalAVStream]);

  // --- Recording Functions ---
  const startRecording = async () => {
    if (isRecording) return;
    if (
      !finalAVStreamRef.current ||
      finalAVStreamRef.current.getTracks().length === 0
    ) {
      setRecordingError("A/V stream not ready. Enable audio and camera first.");
      return;
    }

    recordedChunksRef.current = [];
    setVideoBlob(null);
    setRecordingError(null);

    const options = { mimeType: "video/webm; codecs=vp9,opus" };
    let recorder;

    try {
      recorder = new MediaRecorder(finalAVStreamRef.current, options);
      mediaRecorderRef.current = recorder;
    } catch (error) {
      try {
        const fallbackOptions = { mimeType: "video/webm" };
        recorder = new MediaRecorder(finalAVStreamRef.current, fallbackOptions);
        mediaRecorderRef.current = recorder;
      } catch (fallbackError) {
        setRecordingError(`MediaRecorder failed: ${fallbackError.message}`);
        return;
      }
    }

    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };

    mediaRecorderRef.current.onstop = () => {
      const mimeType = mediaRecorderRef.current?.mimeType || options.mimeType;
      const blob = new Blob(recordedChunksRef.current, { type: mimeType });
      setVideoBlob(blob);
      setIsRecording(false);
      recordedChunksRef.current = [];
    };

    mediaRecorderRef.current.onerror = (event) => {
      console.error("MediaRecorder error:", event.error);
      setRecordingError(`Recording error: ${event.error.name}`);
      setIsRecording(false);
    };

    try {
      mediaRecorderRef.current.start();
      setIsRecording(true);
    } catch (error) {
      setRecordingError(`Failed to start: ${error.message}`);
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === "recording"
    ) {
      mediaRecorderRef.current.stop();
    } else {
      setIsRecording(false);
    }
  };

  useEffect(() => {
    return () => {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === "recording"
      ) {
        mediaRecorderRef.current.stop();
      }
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
      }
    };
  }, []);

  const handleDownloadRecording = () => {
    if (!videoBlob) return;
    try {
      const objectUrl = URL.createObjectURL(videoBlob);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = objectUrl;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `air-piano-session-${timestamp}.webm`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(objectUrl);
      document.body.removeChild(a);
    } catch (error) {
      console.error("Download error:", error);
    }
  };

  return (
    <div className="relative w-screen h-screen bg-bg text-fg overflow-hidden flex flex-col font-sans select-none">
      {/* ── Topbar (Design System) ─────────────────────────────── */}
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__brand-icon">🎹</span>
          <span className="topbar__brand-text">Air Piano</span>
          <span className="topbar__track-badge">In Depth</span>
        </div>

        {/* Center Live HUD Status Indicators */}
        <div className="hidden md:flex items-center gap-3">
          {isLoading ? (
            <span className="badge badge--warning">
              <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
              Loading AI Models...
            </span>
          ) : isCameraReady ? (
            <span className="badge badge--success">
              <span className="w-1.5 h-1.5 rounded-full bg-success"></span>
              Vision Ready
            </span>
          ) : (
            <span className="badge badge--danger">Camera Inactive</span>
          )}

          <span className="badge badge--muted">
            🖐️ {handsDetected} {handsDetected === 1 ? "Hand" : "Hands"}
          </span>

          <span
            className={`badge ${isAudioStarted ? "badge--accent" : "badge--warning"}`}
          >
            🔊 {isAudioStarted ? "Synth Online" : "Audio Off"}
          </span>

          <span className="tag">
            Pitch: {pitchOffsetState >= 0 ? `+${pitchOffsetState}` : pitchOffsetState} st
          </span>
        </div>

        {/* Topbar Actions */}
        <div className="topbar__actions">
          {/* Audio Start / Mute button */}
          {!isAudioStarted ? (
            <button
              onClick={handleStartAudio}
              className="btn btn--primary btn--sm"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              Enable Audio
            </button>
          ) : (
            <div className="flex items-center gap-2">
              {/* Volume Slider */}
              <div className="hidden lg:flex items-center gap-2 px-2 py-1 bg-surface border border-border rounded-md">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/></svg>
                <input
                  type="range"
                  min="-24"
                  max="0"
                  step="1"
                  value={volume}
                  onChange={handleVolumeChange}
                  className="w-16 h-1"
                  title={`Volume: ${volume} dB`}
                />
              </div>

              {/* Mic Toggle */}
              <button
                onClick={userMicStream ? stopMicrophoneCapture : startMicrophoneCapture}
                className={`btn btn--sm ${userMicStream ? "btn--success" : "btn--secondary"}`}
                title={userMicStream ? "Disable Microphone" : "Enable Microphone for recording"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                  <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
                <span className="hidden sm:inline">
                  {userMicStream ? "Mic On" : "Mic"}
                </span>
              </button>
            </div>
          )}

          {/* Help Modal Toggle */}
          <button
            onClick={() => setShowHelpModal(true)}
            className="topbar__btn"
            title="Gesture Guide & Instructions"
            aria-label="Gesture Guide"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </button>

          {/* Theme Toggle */}
          <button
            onClick={toggleTheme}
            className="topbar__btn"
            title="Toggle dark / light theme"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>

          {/* GitHub Repo */}
          <a
            href="https://github.com/innovatorved/piano-web"
            target="_blank"
            rel="noopener noreferrer"
            className="topbar__btn"
            title="GitHub Repository"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
          </a>
        </div>
      </header>

      {/* ── Studio Stage (Full bleed Canvas with sleek dark frame) ── */}
      <main className="relative flex-1 w-full h-full overflow-hidden mt-[56px] flex items-center justify-center bg-bg">
        {/* Hidden video capturing webcam feed */}
        <video
          ref={webcamRef}
          autoPlay
          playsInline
          className="hidden"
        ></video>

        {/* High-res MediaPipe Hand Canvas */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full object-cover z-0"
        ></canvas>

        {/* Subtle studio vignette overlay */}
        <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-bg via-transparent to-bg/40 z-0"></div>

        {/* Global Loading Overlay */}
        {isLoading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-bg/80 backdrop-blur-md">
            <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin mb-4"></div>
            <h3 className="text-base font-semibold text-fg">Initializing Vision Models...</h3>
            <p className="text-xs text-fg-muted mt-1">Downloading MediaPipe Hands and calibrating camera stream</p>
          </div>
        )}

        {/* Global Error Banner */}
        {errorMessage && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 max-w-md w-full px-4">
            <div className="card border-error/50 bg-error/10 text-error flex items-center justify-between p-3">
              <span className="text-xs font-medium">{errorMessage}</span>
              <button
                onClick={() => setErrorMessage("")}
                className="text-xs font-bold hover:underline ml-2"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* First Time Audio Initialization Dialog */}
        {!isLoading && isCameraReady && !isAudioStarted && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg/60 backdrop-blur-sm p-4">
            <div className="card panel-glass max-w-md w-full p-6 text-center flex flex-col items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-accent/10 border border-accent/30 grid place-items-center text-accent text-2xl">
                🎹
              </div>
              <div>
                <h2 className="text-lg font-bold text-fg">Welcome to Air Piano</h2>
                <p className="text-xs text-fg-muted mt-1.5 leading-relaxed">
                  Wave and raise your fingers in front of your camera to trigger lush chords. Click below to start the Tone.js audio engine.
                </p>
              </div>

              <button
                onClick={handleStartAudio}
                className="btn btn--primary btn--lg w-full"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                Enable Audio Engine
              </button>

              <div className="flex items-center gap-3 text-[11px] text-fg-faint">
                <span>FM PolySynth</span>
                <span>•</span>
                <span>Live Pitch Bend</span>
                <span>•</span>
                <span>4K/HD Video Take</span>
              </div>
            </div>
          </div>
        )}

        {/* ── Pitch Meter HUD (Right Edge) ─────────────────────── */}
        <div
          className="pitch-meter-container hidden sm:flex"
          title="Wrist vertical displacement controls semitone pitch offset"
        >
          <span className="tag" style={{ fontSize: "9px", padding: "1px 4px" }}>
            +12
          </span>
          <div className="pitch-meter-track">
            <div className="pitch-meter-center"></div>
            <div
              className="pitch-meter-fill"
              style={{
                top: `${Math.min(50, 50 - (pitchOffsetState / MAX_PITCH_OFFSET) * 50)}%`,
                height: `${Math.abs(pitchOffsetState / MAX_PITCH_OFFSET) * 50}%`,
              }}
            ></div>
          </div>
          <span className="tag" style={{ fontSize: "9px", padding: "1px 4px" }}>
            -12
          </span>
          <span
            className="font-mono text-xs font-bold mt-1"
            style={{
              color:
                pitchOffsetState === 0
                  ? "var(--fg-muted)"
                  : pitchOffsetState > 0
                    ? "var(--accent)"
                    : "var(--warning)",
            }}
          >
            {pitchOffsetState >= 0 ? `+${pitchOffsetState}` : pitchOffsetState}
          </span>
        </div>

        {/* ── Interactive Chord Dock (Bottom Center) ──────────── */}
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2 max-w-full px-4">
          <div className="flex items-center gap-2 sm:gap-3 p-1.5 sm:p-2 rounded-2xl panel-glass overflow-x-auto max-w-full">
            {FINGER_NAMES.map((finger) => {
              const meta = CHORD_META[finger];
              const isActive = activeFingers[finger];
              return (
                <button
                  key={finger}
                  onClick={() => triggerManualChord(finger)}
                  className={`chord-card ${isActive ? "active" : ""}`}
                  title={`Raise ${meta.finger} to trigger ${meta.name} (or click to play)`}
                >
                  <span className="chord-card__finger">{meta.finger}</span>
                  <span className="chord-card__name">{meta.name}</span>
                  <span className="chord-card__notes">{meta.notes}</span>
                </button>
              );
            })}
          </div>
          <div className="text-[11px] text-fg-faint tracking-wide flex items-center gap-2">
            <span>Raise finger to sound chord</span>
            <span>•</span>
            <span>Move wrist vertically for pitch bend</span>
          </div>
        </div>

        {/* ── Studio Recording Deck (Bottom Right) ─────────────── */}
        {isAudioStarted && (
          <div className="fixed bottom-6 right-6 z-30 hidden md:block">
            <div className="panel-glass p-3 flex flex-col gap-2.5 min-w-[210px]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-fg">Studio Take</span>
                {isRecording ? (
                  <span className="badge badge--danger animate-pulse font-mono text-[10px]">
                    REC {formatTime(recordingTime)}
                  </span>
                ) : (
                  <span className="tag text-[9px]">WebM 30fps</span>
                )}
              </div>

              {recordingError && (
                <p className="text-[11px] text-error font-medium">{recordingError}</p>
              )}

              {/* Record / Stop / Download actions */}
              <div className="flex items-center gap-2">
                {!isRecording ? (
                  <button
                    onClick={startRecording}
                    disabled={!finalAVStreamRef.current || !!recordingError}
                    className="btn btn--danger btn--sm flex-1"
                  >
                    <span className="w-2 h-2 rounded-full bg-white"></span>
                    Record
                  </button>
                ) : (
                  <button
                    onClick={stopRecording}
                    className="btn btn--secondary btn--sm flex-1 text-error border-error/50"
                  >
                    <span className="w-2 h-2 bg-error"></span>
                    Stop
                  </button>
                )}

                {videoBlob && !isRecording && (
                  <button
                    onClick={handleDownloadRecording}
                    className="btn btn--success btn--sm flex-1"
                    title="Download recorded performance"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
                    </svg>
                    Save ({formatFileSize(videoBlob.size)})
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── Help / Gesture Instructions Modal ─────────────────── */}
      {showHelpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="card panel-glass max-w-lg w-full p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <div className="flex items-center gap-2">
                <span className="topbar__brand-icon">🎹</span>
                <h3 className="text-base font-bold text-fg">Air Piano Instructions</h3>
              </div>
              <button
                onClick={() => setShowHelpModal(false)}
                className="topbar__btn"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 text-xs text-fg-prose">
              <div>
                <h4 className="font-semibold text-fg text-sm mb-1.5 flex items-center gap-2">
                  <span>🖐️</span> Finger Chords
                </h4>
                <p className="leading-relaxed text-fg-muted mb-2">
                  Hold your hand upright towards the webcam. Raise individual fingers above your knuckles to strike chords:
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {FINGER_NAMES.map((finger) => (
                    <div key={finger} className="p-2 bg-surface rounded-md border border-border">
                      <div className="text-[10px] text-fg-muted uppercase font-mono">
                        {CHORD_META[finger].finger}
                      </div>
                      <div className="font-bold text-fg text-xs mt-0.5">
                        {CHORD_META[finger].name}
                      </div>
                      <div className="text-[10px] text-fg-faint font-mono">
                        {CHORD_META[finger].notes}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="font-semibold text-fg text-sm mb-1 flex items-center gap-2">
                  <span>↕️</span> Vertical Pitch Bend
                </h4>
                <p className="leading-relaxed text-fg-muted">
                  Move your wrist up towards the top of your webcam frame to transpose up (up to +12 semitones). Move it down to transpose down (down to -12 semitones).
                </p>
              </div>

              <div>
                <h4 className="font-semibold text-fg text-sm mb-1 flex items-center gap-2">
                  <span>🎙️</span> Microphone & Studio Take
                </h4>
                <p className="leading-relaxed text-fg-muted">
                  Toggle your microphone from the top navigation bar to blend your voice with the synth. Click <strong>Record</strong> in the Studio Take deck to capture your entire performance to a synchronized WebM video!
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-border flex justify-end">
              <button
                onClick={() => setShowHelpModal(false)}
                className="btn btn--primary btn--sm"
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AirPiano;
