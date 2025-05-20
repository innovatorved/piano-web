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
  const [userMicStream, setUserMicStream] = useState(null);
  const [pianoStream, setPianoStream] = useState(null);
  const [micError, setMicError] = useState(null);
  const [errorMessages, setErrorMessages] = useState({});
  const [isRecording, setIsRecording] = useState(false);
  const [recordingError, setRecordingError] = useState(null);
  const [videoBlob, setVideoBlob] = useState(null);
  const [finalAudioStream, setFinalAudioStream] = useState(null); // This was removed, but my previous plan thought it existed. Re-adding for now, will remove if not needed by recorder.

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

    // Check for MediaRecorder support
    if (typeof window.MediaRecorder === "undefined") {
      const mediaRecorderSupportError =
        "Video recording is not supported by your browser. Recording features will be disabled.";
      setErrorMessage(mediaRecorderSupportError); // Set as a global error for prominence
      setErrorMessages((prev) => ({
        ...prev,
        mediaRecorder: mediaRecorderSupportError,
      }));
      setIsLoading(false); // Stop loading as core functionality is missing
      // No need to return early, let other setup proceed if it can, but recording will be disabled.
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

        // Capture stream from canvas
        if (canvasRef.current.captureStream) {
          canvasStreamRef.current = canvasRef.current.captureStream(30); // 30 FPS
          console.log("Canvas stream captured:", canvasStreamRef.current);
        } else {
          console.warn("canvas.captureStream() is not supported.");
          setErrorMessages((prev) => ({
            ...prev,
            canvas: "Canvas stream capture not supported.",
          }));
        }

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

        // Setup piano audio stream
        if (Tone.context && Tone.context.createMediaStreamDestination) {
          const pianoDestNode = Tone.context.createMediaStreamDestination();
          Tone.getDestination().connect(pianoDestNode);
          pianoAudioStreamRef.current = pianoDestNode.stream;
          setPianoStream(pianoDestNode.stream); // Save to state if UI needs to react
          console.log(
            "Piano audio stream created:",
            pianoAudioStreamRef.current,
          );
        } else {
          console.warn(
            "Tone.context.createMediaStreamDestination is not available.",
          );
          setErrorMessages((prev) => ({
            ...prev,
            piano: "Piano audio stream creation failed.",
          }));
        }

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

  const stopMicrophoneCapture = () => {
    if (micStreamRef.current) {
      console.log("Stopping microphone capture...");
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
      setUserMicStream(null);
      setMicError(null); // Clear any previous mic errors
      setErrorMessages((prev) => ({ ...prev, microphone: "Disabled" }));
    } else {
      console.log("Microphone already stopped or not initialized.");
    }
  };

  // --- Microphone Capture ---
  const startMicrophoneCapture = async () => {
    setMicError(null);
    setErrorMessages((prev) => ({ ...prev, microphone: null }));
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error("getUserMedia not supported for microphone.");
      setMicError(
        "Microphone access (getUserMedia) is not supported by your browser.",
      );
      setErrorMessages((prev) => ({
        ...prev,
        microphone: "getUserMedia not supported.",
      }));
      return;
    }
    try {
      console.log("Requesting microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      micStreamRef.current = stream;
      setUserMicStream(stream); // Update state to trigger UI changes if needed
      console.log("Microphone access granted, stream:", stream);
    } catch (error) {
      console.error("Error accessing microphone:", error);
      if (
        error.name === "NotAllowedError" ||
        error.name === "PermissionDeniedError"
      ) {
        setMicError(
          "Microphone permission denied. Please allow microphone access.",
        );
        setErrorMessages((prev) => ({
          ...prev,
          microphone: "Permission denied.",
        }));
      } else {
        setMicError(
          "Could not access microphone. Ensure it's connected and not in use.",
        );
        setErrorMessages((prev) => ({ ...prev, microphone: "Access error." }));
      }
      setUserMicStream(null);
    }
  };

  // --- Combined Audio Stream Preparation ---
  const prepareFinalAudioStream = useCallback(() => {
    console.log("Preparing final audio stream...");
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
        console.log("Combining piano and microphone audio streams.");
        const audioContext = Tone.context;
        const pianoSource =
          audioContext.createMediaStreamSource(currentPianoStream);
        const micSource =
          audioContext.createMediaStreamSource(currentMicStream);
        const combinedDestination = audioContext.createMediaStreamDestination();

        pianoSource.connect(combinedDestination);
        micSource.connect(combinedDestination);

        finalStream = combinedDestination.stream;
        console.log("Successfully combined audio streams:", finalStream);
      } catch (error) {
        console.error("Error combining audio streams:", error);
        setErrorMessages((prev) => ({
          ...prev,
          combinedAudio: "Error combining streams.",
        }));
        // Fallback to piano stream if combination fails
        if (
          currentPianoStream &&
          currentPianoStream.getAudioTracks().length > 0
        ) {
          finalStream = currentPianoStream;
          console.warn(
            "Falling back to piano stream only due to combination error.",
          );
        } else {
          finalStream = null;
        }
      }
    } else if (
      currentPianoStream &&
      currentPianoStream.getAudioTracks().length > 0
    ) {
      console.log("Using piano audio stream only.");
      finalStream = currentPianoStream;
    } else if (
      currentMicStream &&
      currentMicStream.getAudioTracks().length > 0
    ) {
      console.log(
        "Using microphone audio stream only (unexpected for this app, but handling).",
      );
      finalStream = currentMicStream;
    } else {
      console.warn("No audio streams available to prepare for recording.");
      finalStream = null;
    }

    combinedAudioStreamRef.current = finalStream;
    setFinalAudioStream(finalStream);
    if (!finalStream) {
      setErrorMessages((prev) => ({
        ...prev,
        combinedAudio: "No audio stream available for recording.",
      }));
    } else {
      setErrorMessages((prev) => ({ ...prev, combinedAudio: null }));
    }
  }, []); // Dependencies will be handled by useEffect

  // Effect to update combined audio stream when piano or mic streams change
  useEffect(() => {
    prepareFinalAudioStream();
  }, [pianoStream, userMicStream, prepareFinalAudioStream]);

  // --- Final A/V Stream Preparation ---
  const prepareFinalAVStream = useCallback(() => {
    console.log("Preparing final A/V stream for recording...");
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
        console.log("Successfully created final A/V stream:", newAVStream);
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
      let errorMsg = "Cannot create A/V stream: ";
      if (!hasVideo) errorMsg += "Video track missing. ";
      if (!hasAudio) errorMsg += "Audio track missing.";
      console.warn(errorMsg.trim());
      finalAVStreamRef.current = null;
      setErrorMessages((prev) => ({ ...prev, avStream: errorMsg.trim() }));
    }
  }, []); // Dependencies will be handled by useEffect

  // Effect to update final A/V stream when canvas or combined audio stream changes
  useEffect(() => {
    // isCameraReady implies canvasStreamRef.current should be available
    // finalAudioStream is the state for combinedAudioStreamRef.current
    if (isCameraReady && finalAudioStream) {
      // finalAudioStream state is used here
      prepareFinalAVStream();
    } else if (!isCameraReady || !finalAudioStream) {
      // If sources are not ready, ensure the final AV stream is also cleared
      finalAVStreamRef.current = null;
      let errorParts = [];
      if (!isCameraReady) errorParts.push("Canvas stream not ready");
      if (!finalAudioStream) errorParts.push("Combined audio stream not ready"); // And here
      setErrorMessages((prev) => ({
        ...prev,
        avStream: `Cannot prepare A/V stream: ${errorParts.join(", ")}.`,
      }));
    }
  }, [isCameraReady, finalAudioStream, prepareFinalAVStream]); // And here

  // --- Recording Functions ---
  const startRecording = async () => {
    console.log("Attempting to start recording...");
    if (isRecording) {
      console.log("Already recording.");
      return;
    }
    if (
      !finalAVStreamRef.current ||
      finalAVStreamRef.current.getTracks().length === 0
    ) {
      setRecordingError(
        "Cannot start recording: AV stream not ready or has no tracks.",
      );
      console.error(
        "Cannot start recording: AV stream not ready or has no tracks. Current stream:",
        finalAVStreamRef.current,
      );
      setErrorMessages((prev) => ({
        ...prev,
        recording: "AV stream not ready.",
      }));
      return;
    }

    recordedChunksRef.current = [];
    setVideoBlob(null);
    setRecordingError(null);
    setErrorMessages((prev) => ({ ...prev, recording: null }));

    const options = { mimeType: "video/webm; codecs=vp9,opus" };
    let recorder;

    try {
      recorder = new MediaRecorder(finalAVStreamRef.current, options);
      mediaRecorderRef.current = recorder;
    } catch (error) {
      console.error("Failed to create MediaRecorder:", error);
      setRecordingError(`Failed to create MediaRecorder: ${error.message}`);
      setErrorMessages((prev) => ({
        ...prev,
        recording: `Recorder creation failed: ${error.message}`,
      }));
      // Attempt fallback if specific codecs failed
      try {
        console.log(
          "Attempting fallback MediaRecorder with default mimeType...",
        );
        const fallbackOptions = { mimeType: "video/webm" };
        recorder = new MediaRecorder(finalAVStreamRef.current, fallbackOptions);
        mediaRecorderRef.current = recorder;
        console.log("Fallback MediaRecorder created successfully.");
      } catch (fallbackError) {
        console.error(
          "Fallback MediaRecorder creation also failed:",
          fallbackError,
        );
        setRecordingError(
          `Fallback MediaRecorder failed: ${fallbackError.message}`,
        );
        setErrorMessages((prev) => ({
          ...prev,
          recording: `Fallback recorder failed: ${fallbackError.message}`,
        }));
        return;
      }
    }

    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
        console.log("Data available, chunk size:", event.data.size);
      }
    };

    mediaRecorderRef.current.onstop = () => {
      console.log("Recording stopped. Creating blob...");
      // Use the mimeType from the recorder instance, in case fallback was used
      const mimeType = mediaRecorderRef.current?.mimeType || options.mimeType;
      const blob = new Blob(recordedChunksRef.current, { type: mimeType });
      setVideoBlob(blob);
      setIsRecording(false);
      recordedChunksRef.current = [];
      console.log(
        "Recording stopped, blob created. Size:",
        blob.size,
        "Type:",
        blob.type,
      );
      setErrorMessages((prev) => ({ ...prev, recording: null }));
    };

    mediaRecorderRef.current.onerror = (event) => {
      console.error("MediaRecorder error:", event.error);
      setRecordingError(
        `MediaRecorder error: ${event.error.name} - ${event.error.message}`,
      );
      setErrorMessages((prev) => ({
        ...prev,
        recording: `Recorder error: ${event.error.name}`,
      }));
      setIsRecording(false);
    };

    try {
      mediaRecorderRef.current.start();
      setIsRecording(true);
      console.log("Recording started successfully.");
    } catch (error) {
      console.error("Error starting MediaRecorder:", error);
      setRecordingError(`Error starting MediaRecorder: ${error.message}`);
      setErrorMessages((prev) => ({
        ...prev,
        recording: `Recorder start failed: ${error.message}`,
      }));
      setIsRecording(false); // Ensure isRecording is false if start fails
    }
  };

  const stopRecording = () => {
    console.log("Attempting to stop recording...");
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === "recording"
    ) {
      mediaRecorderRef.current.stop(); // This will trigger the onstop handler
      console.log("Stop recording initiated via stopRecording().");
    } else {
      console.log(
        "Not recording or MediaRecorder not initialized/already stopped.",
      );
      if (isRecording) {
        // If state is somehow out of sync
        setIsRecording(false);
      }
    }
  };

  // Cleanup effect for MediaRecorder
  useEffect(() => {
    return () => {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === "recording"
      ) {
        console.log("Component unmounting, stopping recording...");
        mediaRecorderRef.current.stop();
      }
      // Clean up any stream references if they are still active and managed by this component directly
      // This is more of a general cleanup, specific stream cleanup is handled in their respective useEffects
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
      }
      // pianoAudioStreamRef and canvasStreamRef are managed by Tone.js and camera setup respectively
      // and should have their own cleanup.
    };
  }, []); // Empty dependency array means this runs on unmount

  // --- Download Recording Function ---
  const handleDownloadRecording = () => {
    if (!videoBlob) {
      console.error("No recording available for download.");
      setErrorMessages((prev) => ({
        ...prev,
        download: "No recording available.",
      }));
      return;
    }
    setErrorMessages((prev) => ({ ...prev, download: null })); // Clear previous download errors

    try {
      const objectUrl = URL.createObjectURL(videoBlob);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = objectUrl;
      // Generate a filename with a timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `air-piano-recording-${timestamp}.webm`;

      document.body.appendChild(a);
      a.click();

      // Clean up
      window.URL.revokeObjectURL(objectUrl);
      document.body.removeChild(a);

      console.log("Download initiated for:", a.download);
      setErrorMessages((prev) => ({ ...prev, download: "Download started." })); // Feedback for user
    } catch (error) {
      console.error("Error during download initiation:", error);
      setErrorMessages((prev) => ({
        ...prev,
        download: "Download failed to start.",
      }));
    }
  };

  // --- JSX with Tailwind CSS Styling ---
  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-black text-white overflow-hidden">
      {/* Header section */}
      <div className="absolute top-0 left-0 w-full flex justify-center items-center p-4 z-30 bg-black bg-opacity-50">
        <div className="text-center">
          <h1 className="text-xl md:text-4xl font-bold text-white">
            Web Air Piano
          </h1>
          <p className="text-xs text-gray-300">Created by Smriti</p>
        </div>
      </div>

      {/* Main Status Messages (Loading, Global Errors) */}
      <div className="absolute top-20 left-0 w-full flex justify-center items-center z-20 px-4">
        {isLoading && (
          <p className="status-message bg-black bg-opacity-60">
            Loading Models and Camera...
          </p>
        )}
        {errorMessage && (
          <p className="status-message bg-red-900 bg-opacity-70">
            {errorMessage}
          </p>
        )}
        {!isLoading && !isCameraReady && !errorMessage && (
          <p className="status-message bg-black bg-opacity-60">
            Waiting for camera access...
          </p>
        )}
      </div>

      {/* Control Panel - Positioned below global status messages */}
      <div className="absolute top-32 left-0 w-full flex flex-col items-center z-20 space-y-2 px-4">
        {/* Audio Enable Button & Status */}
        {!isLoading && isCameraReady && !isAudioStarted && (
          <button
            onClick={handleStartAudio}
            className="control-button bg-green-600 hover:bg-green-500 p-2 text-xs rounded-lg"
          >
            Enable Audio
          </button>
        )}
        {isAudioStarted && (
          <div className="status-indicator-small text-green-700 flex items-center text-xs font-bold">
            <div className="w-3 h-3 rounded-full bg-green-400 mr-2 animate-pulse p-2 text-xs"></div>
            Audio Enabled
          </div>
        )}

        {/* Microphone Controls */}
        {isAudioStarted && ( // Only show mic controls if audio context is started
          <div className="flex flex-col items-center space-y-1 w-full max-w-xs o">
            <button
              onClick={
                userMicStream ? stopMicrophoneCapture : startMicrophoneCapture
              }
              disabled={!isAudioStarted} // Ensure audio is started before allowing mic changes
              className={`control-button p-2 rounded-md text-xs ${userMicStream ? "bg-yellow-600 hover:bg-yellow-500" : "bg-blue-600 hover:bg-blue-500"} ${!isAudioStarted ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {userMicStream ? "Disable Microphone" : "Enable Microphone"}
            </button>
            <p className="text-xs text-gray-300">
              Microphone:{" "}
              {micError ? (
                <span className="text-red-400">{micError}</span>
              ) : userMicStream ? (
                <span className="text-green-400">Enabled</span>
              ) : errorMessages.microphone === "Disabled" ? (
                <span className="text-yellow-400">Disabled</span>
              ) : errorMessages.microphone ? (
                <span className="text-red-400">{errorMessages.microphone}</span>
              ) : (
                <span className="text-gray-400">Not Active</span>
              )}
            </p>
          </div>
        )}
      </div>

      {/* Hidden video element */}
      <video ref={webcamRef} autoPlay playsInline className="hidden"></video>

      {/* Canvas - Fullscreen, ensure it's behind the controls */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full object-cover z-0"
      ></canvas>

      {/* Recording Controls & Download Card - SMALL, bottom right */}
      {isAudioStarted && (
        <div className="fixed bottom-4 right-4 z-40 text-xs">
          <div className="rounded-xl shadow-2xl bg-gradient-to-br from-gray-900/90 to-gray-800/90 border border-gray-700 px-4 py-3 flex flex-col items-center space-y-2 w-64 max-w-[90vw]">
            {/* Recording Buttons */}
            <div className="flex items-center space-x-2 w-full justify-center">
              <button
                onClick={startRecording}
                disabled={
                  isRecording ||
                  !finalAVStreamRef.current ||
                  !!recordingError ||
                  !!errorMessages.avStream ||
                  !!errorMessages.mediaRecorder ||
                  !!errorMessages.canvas ||
                  !!errorMessages.piano
                }
                className={`flex items-center text-xs gap-2 px-3 py-1 rounded-full font-semibold transition-all duration-150 shadow-md
                  ${
                    isRecording ||
                    !finalAVStreamRef.current ||
                    !!recordingError ||
                    !!errorMessages.avStream ||
                    !!errorMessages.mediaRecorder ||
                    !!errorMessages.canvas ||
                    !!errorMessages.piano
                      ? "bg-red-700/60 text-red-200 cursor-not-allowed"
                      : "bg-red-600 hover:bg-red-500 text-white"
                  }
                `}
              >
                <span className="inline-block w-2 h-2 rounded-full bg-red-400 animate-pulse"></span>
                Record
              </button>
              <button
                onClick={stopRecording}
                disabled={!isRecording || !!errorMessages.mediaRecorder}
                className={`flex items-center gap-2 px-3 py-1  rounded-full font-semibold text-xs transition-all duration-150 shadow-md
                  ${
                    !isRecording || !!errorMessages.mediaRecorder
                      ? "bg-gray-600 text-gray-300 cursor-not-allowed"
                      : "bg-red-500 hover:bg-red-400 text-white"
                  }
                `}
              >
                <svg
                  className="w-3 h-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <rect
                    x="6"
                    y="6"
                    width="12"
                    height="12"
                    rx="2"
                    fill="currentColor"
                  />
                </svg>
                Stop
              </button>
            </div>

            {/* Recording Status */}
            <div className="w-full flex flex-col items-center space-y-1">
              {isRecording && (
                <div className="flex items-center gap-2 bg-red-700/80 px-2 py-0.5 rounded-full text-xs font-semibold text-white animate-pulse shadow">
                  <span className="inline-block w-2 h-2 rounded-full bg-red-400"></span>
                  Recording...
                </div>
              )}
              {recordingError && (
                <p className="text-xs text-red-400 font-semibold">
                  {recordingError}
                </p>
              )}
              {errorMessages.mediaRecorder && (
                <p className="text-xs text-red-500 font-semibold">
                  {errorMessages.mediaRecorder}
                </p>
              )}
              {errorMessages.canvas && (
                <p className="text-xs text-yellow-400">
                  Canvas: {errorMessages.canvas}
                </p>
              )}
              {errorMessages.piano && (
                <p className="text-xs text-yellow-400">
                  Piano: {errorMessages.piano}
                </p>
              )}
              {errorMessages.avStream && (
                <p className="text-xs text-yellow-400">
                  AV: {errorMessages.avStream}
                </p>
              )}
              {errorMessages.combinedAudio && (
                <p className="text-xs text-yellow-400">
                  Audio: {errorMessages.combinedAudio}
                </p>
              )}
            </div>

            {/* Download Section */}
            <div className="w-full flex flex-col items-center space-y-1 mt-1">
              <button
                onClick={handleDownloadRecording}
                disabled={
                  !videoBlob || isRecording || !!errorMessages.mediaRecorder
                }
                className={`flex items-center gap-2 px-3 py-1 rounded-full font-semibold text-xs transition-all duration-150 shadow-md
                  ${
                    !videoBlob || isRecording || !!errorMessages.mediaRecorder
                      ? "bg-green-700/60 text-green-200 cursor-not-allowed"
                      : "bg-green-600 hover:bg-green-500 text-white"
                  }
                `}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16"
                  />
                </svg>
                Download
              </button>
              {videoBlob && !isRecording && (
                <div className="flex items-center gap-1 text-green-400 text-xs font-semibold">
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  Ready for download!
                </div>
              )}
              {errorMessages.download && (
                <p
                  className={`text-xs mt-0.5 ${errorMessages.download.includes("failed") || errorMessages.download.includes("No recording") ? "text-red-400" : "text-green-400"}`}
                >
                  {errorMessages.download}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Instructions overlay - ensure it's above canvas but below other top controls if necessary */}
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

// Helper styles - can be moved to CSS file or a style block
const controlButtonBase =
  "px-3 py-1 text-xs font-bold rounded-lg shadow-md transition-all duration-200 transform hover:scale-105";
const statusMessageBase = "text-base px-3 py-1 rounded-lg";
const statusIndicatorSmallBase =
  "px-2 py-1 text-xs rounded-lg flex items-center";

// Add these utility classes to your Tailwind config or global CSS if you want to use @apply
// For now, I'll inline them in the JSX using string templates for simplicity in this environment.
// Example: className={`${controlButtonBase} bg-blue-600 hover:bg-blue-500`}

// Modify the JSX to use these base styles for better readability
// Note: For this pass, I've manually added common classes and will refine if needed.
// The above constants are for reference for a real project.

export default AirPiano;
