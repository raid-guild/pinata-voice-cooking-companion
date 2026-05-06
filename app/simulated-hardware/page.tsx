"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import styles from "./simulated-hardware.module.css";

type LedState = "off" | "booting" | "connecting" | "ready" | "recording" | "thinking" | "playing" | "error";
type MicPermissionState = "unknown" | "requesting" | "ready" | "denied" | "unavailable";

type AudioQueryResponse = {
  ok: boolean;
  answerText: string;
  audio?: {
    mimeType: string;
    url: string;
  };
  session?: {
    id: string;
    activeRecipeId: string | null;
    stepIndex: number;
    phase: "ingredients" | "steps";
  };
};

function logPress(buttonName: string) {
  console.log(`[simulated-hardware] ${buttonName} pressed`);
}

function suppressLongPress(event: React.MouseEvent | React.TouchEvent) {
  event.preventDefault();
}

function suppressNativeContextMenu(event: Event) {
  event.preventDefault();
}

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return `sess_${crypto.randomUUID()}`;
  const existing = window.localStorage.getItem("simulated-hardware-session-id");
  if (existing) return existing;
  const created = `sess_${crypto.randomUUID()}`;
  window.localStorage.setItem("simulated-hardware-session-id", created);
  return created;
}

function ledLabel(state: LedState): string {
  switch (state) {
    case "off":
      return "Powered off";
    case "booting":
      return "Booting";
    case "connecting":
      return "Connecting Wi-Fi";
    case "ready":
      return "Ready";
    case "recording":
      return "Recording";
    case "thinking":
      return "Uploading / thinking";
    case "playing":
      return "Playing response";
    case "error":
      return "Error";
  }
}

function ledVisual(state: LedState, timeSeconds: number) {
  switch (state) {
    case "off":
      return { color: 0x1a1a1a, intensity: 0, glow: 0 };
    case "booting":
      return { color: 0xffb347, intensity: 1.6, glow: 0.55 };
    case "connecting": {
      const blink = Math.sin(timeSeconds * 8) > 0 ? 1 : 0.15;
      return { color: 0x5ea9ff, intensity: 2.2 * blink, glow: 0.7 * blink };
    }
    case "ready":
      return { color: 0x4fe36c, intensity: 1.9, glow: 0.6 };
    case "recording": {
      const pulse = 0.45 + (Math.sin(timeSeconds * 7) + 1) * 0.35;
      return { color: 0xff4b4b, intensity: 1.2 + pulse, glow: pulse };
    }
    case "thinking": {
      const pulse = 0.35 + (Math.sin(timeSeconds * 5.5) + 1) * 0.28;
      return { color: 0xffb347, intensity: 1.1 + pulse, glow: pulse * 0.85 };
    }
    case "playing": {
      const pulse = 0.3 + (Math.sin(timeSeconds * 6) + 1) * 0.32;
      return { color: 0xffffff, intensity: 1.1 + pulse, glow: pulse * 0.75 };
    }
    case "error": {
      const blink = Math.sin(timeSeconds * 10) > 0 ? 1 : 0.1;
      return { color: 0xff3a32, intensity: 2.4 * blink, glow: 0.85 * blink };
    }
  }
}

function getLowestWorldY(root: THREE.Object3D): number {
  root.updateWorldMatrix(true, true);
  let lowestY = Number.POSITIVE_INFINITY;
  const point = new THREE.Vector3();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry;
    const position = geometry.getAttribute("position");
    if (!position) return;

    for (let index = 0; index < position.count; index += 1) {
      point.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
      if (point.y < lowestY) lowestY = point.y;
    }
  });

  return Number.isFinite(lowestY) ? lowestY : 0;
}

function cadToScene(x: number, y: number, z: number) {
  return new THREE.Vector3(x, z, y);
}

type DeviceProps = {
  ledState: LedState;
  onMainPress: () => void;
  onTalkStart: () => void;
  onTalkEnd: () => void;
};

function FallbackDevice({ ledState, onMainPress, onTalkStart, onTalkEnd }: DeviceProps) {
  return (
    <div className={styles.device} aria-label="Simulated hardware device">
      <div className={styles.shadow} aria-hidden="true" />
      <div className={`${styles.face} ${styles.topFace}`} aria-hidden="true" />
      <div className={`${styles.face} ${styles.frontFace}`}>
        <button
          type="button"
          className={`${styles.button} ${styles.mainButton}`}
          onClick={() => {
            logPress("Next Step");
            onMainPress();
          }}
          onContextMenu={suppressLongPress}
          aria-label="Next Step"
        >
          <span className={styles.ring} aria-hidden="true" />
          <span className={styles.core} aria-hidden="true" />
        </button>
      </div>
      <div className={`${styles.face} ${styles.sideFace}`}>
        <button
          type="button"
          className={`${styles.button} ${styles.talkButton}`}
          onPointerDown={onTalkStart}
          onPointerUp={onTalkEnd}
          onPointerCancel={onTalkEnd}
          onPointerLeave={onTalkEnd}
          onContextMenu={suppressLongPress}
          aria-label="Talk Button"
        >
          <span className={styles.ring} aria-hidden="true" />
          <span className={styles.core} aria-hidden="true" />
        </button>
      </div>
      <div className={`${styles.led} ${styles[`led-${ledState}`]}`} aria-label={`Status light: ${ledLabel(ledState)}`} />
    </div>
  );
}

export default function SimulatedHardwarePage() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const talkActiveRef = useRef(false);
  const requestInFlightRef = useRef(false);
  const sessionIdRef = useRef<string>("");
  const ledStateRef = useRef<LedState>("ready");
  const micPermissionReadyRef = useRef(false);
  const recordingStartedAtRef = useRef<number | null>(null);
  const errorResetTimeoutRef = useRef<number | null>(null);
  const [useFallback, setUseFallback] = useState(false);
  const [ledState, setLedState] = useState<LedState>("ready");
  const [statusText, setStatusText] = useState("Ready");
  const [micPermissionState, setMicPermissionState] = useState<MicPermissionState>("unknown");
  const [lastAnswerText, setLastAnswerText] = useState("");
  const [pendingAudioUrl, setPendingAudioUrl] = useState<string | null>(null);
  const [cameraUnlocked, setCameraUnlocked] = useState(false);
  const [cameraReadout, setCameraReadout] = useState({
    position: { x: 10.96, y: 3.56, z: 9.21 },
    target: { x: 3.2, y: 0.95, z: 2.1 }
  });
  const cameraPoseRef = useRef({
    position: new THREE.Vector3(10.96, 3.56, 9.21),
    target: new THREE.Vector3(3.2, 0.95, 2.1)
  });

  const sessionId = useMemo(() => getOrCreateSessionId(), []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    ledStateRef.current = ledState;
  }, [ledState]);

  const setErrorState = useCallback((message: string) => {
    if (errorResetTimeoutRef.current) window.clearTimeout(errorResetTimeoutRef.current);
    setStatusText(message);
    setLedState("error");
    errorResetTimeoutRef.current = window.setTimeout(() => {
      setLedState("ready");
      setStatusText(micPermissionReadyRef.current ? "Ready" : "Tap talk once to enable the microphone");
      errorResetTimeoutRef.current = null;
    }, 2600);
  }, []);

  const stopMediaTracks = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const describeMicrophoneError = useCallback((error: unknown): { state: MicPermissionState; message: string } => {
    const errorName = error instanceof DOMException ? error.name : typeof error === "object" && error && "name" in error ? String(error.name) : "";

    if (errorName === "NotAllowedError" || errorName === "SecurityError") {
      return { state: "denied", message: "Microphone access was denied" };
    }
    if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
      return { state: "unavailable", message: "No microphone was found on this device" };
    }
    if (errorName === "NotReadableError" || errorName === "TrackStartError") {
      return { state: "unavailable", message: "The microphone is busy or unavailable right now" };
    }
    return { state: "unknown", message: "Couldn’t start the microphone" };
  }, []);

  const ensureMicrophoneAccess = useCallback(async (): Promise<{ shouldStartRecordingThisPress: boolean }> => {
    if (micPermissionReadyRef.current) return { shouldStartRecordingThisPress: true };

    try {
      setMicPermissionState("requesting");
      setLedState("thinking");
      setStatusText("Allow microphone access, then press and hold again to talk");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micPermissionReadyRef.current = true;
      setMicPermissionState("ready");
      stream.getTracks().forEach((track) => track.stop());
      setLedState("ready");
      setStatusText("Microphone enabled — now press and hold to record");
      return { shouldStartRecordingThisPress: false };
    } catch (error) {
      micPermissionReadyRef.current = false;
      const { state, message } = describeMicrophoneError(error);
      setMicPermissionState(state);
      setErrorState(message);
      return { shouldStartRecordingThisPress: false };
    }
  }, [describeMicrophoneError, setErrorState]);

  const playResponseAudio = useCallback(
    async (audioUrl: string | undefined, options?: { allowManualFallback?: boolean }) => {
      if (!audioUrl || !audioRef.current) {
        setPendingAudioUrl(null);
        setLedState("ready");
        setStatusText("Ready");
        return true;
      }

      const resolvedUrl = audioUrl.startsWith("http") ? audioUrl : new URL(audioUrl, window.location.origin).toString();
      audioRef.current.src = resolvedUrl;
      setLedState("playing");
      try {
        await audioRef.current.play();
        setPendingAudioUrl(null);
        setStatusText("Playing response");
        return true;
      } catch {
        setPendingAudioUrl(resolvedUrl);
        setLedState("ready");
        setStatusText(
          options?.allowManualFallback === false
            ? "Couldn’t play response audio"
            : "Response ready — tap Play Response for audio"
        );
        return false;
      }
    },
    []
  );

  const sendNextStep = useCallback(async () => {
    if (requestInFlightRef.current || talkActiveRef.current) return;
    requestInFlightRef.current = true;
    setLedState("thinking");

    try {
      const response = await fetch("/app/query-audio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inputMode: "next_step",
          sessionId: sessionIdRef.current
        })
      });
      const result = (await response.json()) as AudioQueryResponse;
      if (result.session?.id) sessionIdRef.current = result.session.id;
      setLastAnswerText(result.answerText || "");
      if (!response.ok || !result.ok) throw new Error(result.answerText || "Next step failed.");
      await playResponseAudio(result.audio?.url, { allowManualFallback: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Next step failed.";
      setErrorState(message);
    } finally {
      requestInFlightRef.current = false;
    }
  }, [playResponseAudio, setErrorState]);

  const uploadRecording = useCallback(
    async (blob: Blob) => {
      requestInFlightRef.current = true;
      setLedState("thinking");
      setStatusText("Uploading / thinking");

      try {
        if (blob.size < 1024) {
          setLedState("ready");
          setStatusText("Ready");
          return;
        }

        const formData = new FormData();
        const normalizedType = (blob.type || "audio/webm").split(";")[0]?.trim().toLowerCase() || "audio/webm";
        const extensionByMime: Record<string, string> = {
          "audio/mpeg": "mp3",
          "audio/mp4": "mp4",
          "audio/x-m4a": "m4a",
          "audio/aac": "aac",
          "audio/x-aac": "aac",
          "audio/wav": "wav",
          "audio/ogg": "ogg",
          "audio/webm": "webm"
        };
        const extension = extensionByMime[normalizedType] ?? "webm";
        formData.append("audio", new File([blob], `query-audio.${extension}`, { type: normalizedType }));
        formData.append("sessionId", sessionIdRef.current);

        const response = await fetch("/app/query-audio", {
          method: "POST",
          body: formData
        });
        const result = (await response.json()) as AudioQueryResponse;
        if (result.session?.id) sessionIdRef.current = result.session.id;
        setLastAnswerText(result.answerText || "");
        if (!response.ok || !result.ok) throw new Error(result.answerText || "Audio query failed.");
        await playResponseAudio(result.audio?.url, { allowManualFallback: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Audio query failed.";
        setErrorState(message);
      } finally {
        requestInFlightRef.current = false;
      }
    },
    [playResponseAudio, setErrorState]
  );

  const handleTalkStart = useCallback(async () => {
    if (requestInFlightRef.current || talkActiveRef.current) return;

    if (!micPermissionReadyRef.current) {
      talkActiveRef.current = true;
      const { shouldStartRecordingThisPress } = await ensureMicrophoneAccess();
      talkActiveRef.current = false;
      if (!shouldStartRecordingThisPress) return;
    }

    talkActiveRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      recordingStartedAtRef.current = performance.now();

      const preferredMimeTypes = [
        "audio/mp4",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/x-m4a",
        "audio/aac",
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg"
      ];
      const mimeType = preferredMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      });

      recorder.addEventListener("stop", async () => {
        const recordingDurationMs = recordingStartedAtRef.current == null ? 0 : performance.now() - recordingStartedAtRef.current;
        recordingStartedAtRef.current = null;
        stopMediaTracks();
        mediaRecorderRef.current = null;
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        audioChunksRef.current = [];
        if (blob.size > 0 && recordingDurationMs >= 250) {
          await uploadRecording(blob);
        } else {
          setLedState("ready");
          setStatusText("Ready");
        }
      });

      recorder.start();
      setLedState("recording");
      setStatusText("Recording");
    } catch (error) {
      recordingStartedAtRef.current = null;
      stopMediaTracks();
      talkActiveRef.current = false;
      micPermissionReadyRef.current = false;
      const { state, message } = describeMicrophoneError(error);
      setMicPermissionState(state);
      setErrorState(message);
    }
  }, [describeMicrophoneError, ensureMicrophoneAccess, setErrorState, stopMediaTracks, uploadRecording]);

  const handleTalkEnd = useCallback(() => {
    if (!talkActiveRef.current) return;
    talkActiveRef.current = false;

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }

    recordingStartedAtRef.current = null;
    stopMediaTracks();
  }, [stopMediaTracks]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setMicPermissionState("denied");
      setStatusText("This browser doesn’t support microphone recording here");
      setLedState("error");
      return;
    }

    let cancelled = false;
    let permissionStatus: PermissionStatus | null = null;

    const hydratePermissionState = async () => {
      const permissions = navigator.permissions as { query?: (descriptor: PermissionDescriptor) => Promise<PermissionStatus> } | undefined;
      if (!permissions?.query) {
        if (!micPermissionReadyRef.current) {
          setStatusText("Tap talk once to enable the microphone");
        }
        return;
      }

      try {
        const status = await permissions.query({ name: "microphone" as PermissionName });
        if (cancelled) return;
        permissionStatus = status;

        const syncState = () => {
          if (status.state === "granted") {
            micPermissionReadyRef.current = true;
            setMicPermissionState("ready");
            setStatusText("Ready");
            setLedState("ready");
            return;
          }
          if (status.state === "denied") {
            micPermissionReadyRef.current = false;
            setMicPermissionState("denied");
            setStatusText("Microphone access is blocked — enable it in Safari settings");
            setLedState("error");
            return;
          }
          micPermissionReadyRef.current = false;
          setMicPermissionState("unknown");
          setStatusText("Tap talk once to enable the microphone");
          setLedState("ready");
        };

        syncState();
        status.onchange = () => {
          if (cancelled) return;
          syncState();
        };
      } catch {
        if (!micPermissionReadyRef.current) {
          setStatusText("Tap talk once to enable the microphone");
        }
      }
    };

    void hydratePermissionState();

    return () => {
      cancelled = true;
      if (permissionStatus) permissionStatus.onchange = null;
    };
  }, []);

  const handleManualPlay = useCallback(async () => {
    if (!pendingAudioUrl || !audioRef.current) return;
    await playResponseAudio(pendingAudioUrl, { allowManualFallback: false });
  }, [pendingAudioUrl, playResponseAudio]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleEnded = () => {
      setLedState("ready");
      setStatusText("Ready");
    };

    const handleError = () => {
      setPendingAudioUrl(audio.currentSrc || pendingAudioUrl);
      setLedState("ready");
      setStatusText("Response ready — tap Play Response for audio");
    };

    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);
    return () => {
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };
  }, [pendingAudioUrl]);

  useEffect(() => {
    return () => {
      if (errorResetTimeoutRef.current) window.clearTimeout(errorResetTimeoutRef.current);
      handleTalkEnd();
      stopMediaTracks();
    };
  }, [handleTalkEnd, stopMediaTracks]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || useFallback) return;
    const mountEl = mount;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setUseFallback(true);
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    if (cameraPoseRef.current.position.equals(new THREE.Vector3(10.96, 3.56, 9.21))) {
      cameraPoseRef.current.position.set(10.96, 3.56, 9.21);
      cameraPoseRef.current.target.set(3.2, 0.95, 2.1);
    }
    camera.position.copy(cameraPoseRef.current.position);
    camera.lookAt(cameraPoseRef.current.target);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mountEl.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enabled = cameraUnlocked;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 0.9;
    controls.minDistance = 6.5;
    controls.maxDistance = 18;
    controls.minPolarAngle = 0.35;
    controls.maxPolarAngle = 1.45;
    controls.target.copy(cameraPoseRef.current.target);
    controls.update();

    const ambient = new THREE.HemisphereLight(0xffffff, 0x9a7b56, 1.35);
    scene.add(ambient);

    const axisOverlay = buildAxisOverlay();
    axisOverlay.visible = cameraUnlocked;
    scene.add(axisOverlay);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(6, 8, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 30;
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xaec4ff, 0.8);
    fill.position.set(-6, 4, 5);
    scene.add(fill);

    const group = new THREE.Group();
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    scene.add(group);

    const caseGroup = new THREE.Group();
    group.add(caseGroup);

    const gltfLoader = new GLTFLoader();
    const modelUrl = new URL("/app/models/Cooking_Companion_Case.glb", window.location.origin).toString();
    gltfLoader.load(
      modelUrl,
      (gltf) => {
        const caseModel = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(caseModel);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const longestSide = Math.max(size.x, size.y, size.z) || 1;
        const scale = 4.9 / longestSide;

        caseModel.position.sub(center);
        caseModel.scale.setScalar(scale);
        caseModel.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.castShadow = true;
            object.receiveShadow = true;
            if (Array.isArray(object.material)) {
              object.material = object.material.map((material) => material.clone());
            } else if (object.material) {
              object.material = object.material.clone();
            }
          }
        });

        const scaledBounds = new THREE.Box3().setFromObject(caseModel);
        caseModel.position.x -= scaledBounds.min.x;
        caseModel.position.y -= scaledBounds.min.y;
        caseModel.position.z -= scaledBounds.min.z;
        caseGroup.add(caseModel);

        const caseBottomY = getLowestWorldY(caseModel);
        floor.position.y = caseBottomY;
        floorShadow.position.y = caseBottomY - 0.002;
      },
      undefined,
      () => {
        const fallbackBody = new THREE.Mesh(
          new THREE.BoxGeometry(4.6, 3.2, 3.1),
          new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.88, metalness: 0.06 })
        );
        fallbackBody.castShadow = true;
        fallbackBody.receiveShadow = true;
        caseGroup.add(fallbackBody);

        const caseBottomY = getLowestWorldY(fallbackBody);
        floor.position.y = caseBottomY;
        floorShadow.position.y = caseBottomY - 0.002;
      }
    );

    const ledMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 24, 24),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: 0x000000, emissiveIntensity: 0 })
    );
    ledMesh.position.copy(cadToScene(3.2, 2.4, 1.3));
    group.add(ledMesh);

    const ledGlowTexture = createLedGlowTexture();
    const ledGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: ledGlowTexture, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })
    );
    ledGlow.position.copy(ledMesh.position);
    ledGlow.scale.set(0.28, 0.28, 1);
    group.add(ledGlow);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(6.5, 64),
      new THREE.MeshStandardMaterial({ color: 0xd7c0a2, roughness: 0.96, metalness: 0.02 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    scene.add(floor);

    const floorShadow = new THREE.Mesh(
      new THREE.CircleGeometry(6.5, 64),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.16 })
    );
    floorShadow.rotation.x = -Math.PI / 2;
    floorShadow.position.y = -0.002;
    floorShadow.receiveShadow = true;
    scene.add(floorShadow);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const clickable: THREE.Object3D[] = [];
    const buttons: Array<{
      name: string;
      ring: THREE.Mesh;
      core: THREE.Mesh;
      hitArea: THREE.Mesh;
      currentPress: number;
      targetPress: number;
      ringBaseZ: number;
      coreBaseZ: number;
    }> = [];

    const mainButton = buildButton("Next Step", 0.367708572, 0.4832741232, 0.22);
    mainButton.group.position.copy(cadToScene(2.35, 2.4, 0.82));
    group.add(mainButton.group);
    clickable.push(mainButton.hitArea);
    buttons.push(mainButton);

    const talkButton = buildButton("Talk Button", 0.22896, 0.331992, 0.14);
    talkButton.group.position.copy(cadToScene(4.8, 1.2, 1.05));
    talkButton.group.rotation.set(0, Math.PI / 2, 0);
    group.add(talkButton.group);
    clickable.push(talkButton.hitArea);
    buttons.push(talkButton);

    let activeButtonName: string | null = null;

    function createLedGlowTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const context = canvas.getContext("2d");
      if (!context) return new THREE.CanvasTexture(canvas);

      const gradient = context.createRadialGradient(64, 64, 8, 64, 64, 64);
      gradient.addColorStop(0, "rgba(255,255,255,0.95)");
      gradient.addColorStop(0.28, "rgba(255,255,255,0.45)");
      gradient.addColorStop(0.58, "rgba(255,255,255,0.12)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 128, 128);

      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      return texture;
    }

    function buildAxisOverlay() {
      const overlay = new THREE.Group();
      overlay.position.set(0, 0, 0);
      overlay.renderOrder = 1000;

      const makeAxis = (start: THREE.Vector3, end: THREE.Vector3, color: number, emphasis = 1) => {
        const direction = new THREE.Vector3().subVectors(end, start);
        const length = direction.length();
        const shaftMaterial = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: Math.min(0.98, 0.65 + emphasis * 0.15),
          depthTest: false,
          depthWrite: false
        });
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015 * emphasis, 0.015 * emphasis, length, 12),
          shaftMaterial
        );
        shaft.position.copy(start).add(end).multiplyScalar(0.5);
        shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
        shaft.renderOrder = 1000;
        overlay.add(shaft);

        const head = new THREE.Mesh(
          new THREE.ConeGeometry(0.045 * emphasis, 0.14 * emphasis, 12),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: Math.min(1, 0.85 + emphasis * 0.05),
            depthTest: false,
            depthWrite: false
          })
        );
        head.position.copy(end);
        head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
        head.renderOrder = 1000;
        overlay.add(head);
      };

      const makeTick = (
        position: THREE.Vector3,
        rotation: THREE.Euler,
        long = false,
        color = 0x4b5563,
        opacity = long ? 0.85 : 0.55,
        vertical = false
      ) => {
        const tick = new THREE.Mesh(
          new THREE.BoxGeometry(long ? 0.14 : 0.08, 0.01, 0.01),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false })
        );
        tick.position.copy(position);
        tick.rotation.copy(rotation);
        if (vertical) {
          tick.rotation.z += Math.PI / 2;
        }
        tick.renderOrder = 1000;
        overlay.add(tick);
      };

      // CAD-style convention shown in overlay:
      // X = left/right (red), Y = depth (green, mapped to Three Z), Z = up (blue, mapped to Three Y)
      makeAxis(new THREE.Vector3(0, 0, 0), new THREE.Vector3(6.2, 0, 0), 0xef4444, 1.6);
      makeAxis(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 6.2), 0x22c55e, 1.6);
      makeAxis(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 3.8, 0), 0x3b82f6, 1.1);

      for (let i = 0; i <= 62; i += 1) {
        const x = i * 0.1;
        makeTick(new THREE.Vector3(x, 0, 0), new THREE.Euler(0, 0, 0), i % 10 === 0, 0xef4444, i % 10 === 0 ? 0.95 : 0.75, true);
      }
      for (let i = 0; i <= 62; i += 1) {
        const depth = i * 0.1;
        makeTick(new THREE.Vector3(0, 0, depth), new THREE.Euler(0, Math.PI / 2, 0), i % 10 === 0, 0x22c55e, i % 10 === 0 ? 0.95 : 0.75, true);
      }
      for (let i = 0; i <= 38; i += 1) {
        const height = i * 0.1;
        const tick = new THREE.Mesh(
          new THREE.BoxGeometry(0.01, 0.01, i % 10 === 0 ? 0.14 : 0.08),
          new THREE.MeshBasicMaterial({ color: 0x4b5563, transparent: true, opacity: i % 10 === 0 ? 0.85 : 0.55, depthTest: false, depthWrite: false })
        );
        tick.position.set(0, height, 0);
        tick.renderOrder = 1000;
        overlay.add(tick);
      }

      return overlay;
    }

    function buildButton(name: string, coreRadius: number, ringRadius: number, depth: number) {
      const buttonGroup = new THREE.Group();

      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(ringRadius, ringRadius, depth, 48),
        new THREE.MeshStandardMaterial({
          color: 0x5ea9ff,
          emissive: 0x2b63ff,
          emissiveIntensity: 1.8,
          roughness: 0.28,
          metalness: 0.18
        })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.z = 0;
      ring.castShadow = true;
      buttonGroup.add(ring);

      const core = new THREE.Mesh(
        new THREE.CylinderGeometry(coreRadius, coreRadius, depth + 0.08, 48),
        new THREE.MeshStandardMaterial({ color: 0x23252a, roughness: 0.84, metalness: 0.06 })
      );
      core.rotation.x = Math.PI / 2;
      core.position.z = 0.05;
      core.castShadow = true;
      buttonGroup.add(core);

      const hitArea = new THREE.Mesh(
        new THREE.CylinderGeometry(ringRadius, ringRadius, depth + 0.2, 48),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })
      );
      hitArea.rotation.x = Math.PI / 2;
      hitArea.position.z = 0.06;
      hitArea.userData.buttonName = name;
      buttonGroup.add(hitArea);

      return {
        name,
        group: buttonGroup,
        ring,
        core,
        hitArea,
        currentPress: 0,
        targetPress: 0,
        ringBaseZ: ring.position.z,
        coreBaseZ: core.position.z
      };
    }

    function resize() {
      const width = mountEl.clientWidth;
      const height = mountEl.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    }

    function setPointer(event: PointerEvent | MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    }

    function onPointerMove(event: PointerEvent) {
      if (cameraUnlocked) {
        renderer.domElement.style.cursor = "grab";
        return;
      }
      setPointer(event);
      const hit = raycaster.intersectObjects(clickable, false);
      renderer.domElement.style.cursor = hit.length ? "pointer" : "default";
    }

    function onPointerDown(event: PointerEvent) {
      if (cameraUnlocked) {
        renderer.domElement.style.cursor = "grabbing";
        return;
      }
      event.preventDefault();
      setPointer(event);
      const hit = raycaster.intersectObjects(clickable, false)[0];
      const buttonName = hit?.object.userData.buttonName as string | undefined;
      activeButtonName = buttonName ?? null;
      buttons.forEach((button) => {
        button.targetPress = button.name === activeButtonName ? 1 : 0;
      });
      if (buttonName === "Talk Button") {
        logPress("Talk Button");
        void handleTalkStart();
      }
    }

    function releaseButtons(triggerAction: boolean) {
      const pressedName = activeButtonName;
      activeButtonName = null;
      buttons.forEach((button) => {
        button.targetPress = 0;
      });
      if (!triggerAction || !pressedName) return;
      if (pressedName === "Next Step") {
        logPress("Next Step");
        void sendNextStep();
      }
      if (pressedName === "Talk Button") {
        handleTalkEnd();
      }
    }

    function onPointerUp() {
      if (cameraUnlocked) {
        renderer.domElement.style.cursor = "grab";
        return;
      }
      releaseButtons(true);
    }

    function onPointerLeave() {
      if (cameraUnlocked) {
        renderer.domElement.style.cursor = "default";
        return;
      }
      if (activeButtonName === "Talk Button") {
        handleTalkEnd();
      }
      releaseButtons(false);
    }

    function onPointerCancel() {
      if (cameraUnlocked) {
        renderer.domElement.style.cursor = "default";
        return;
      }
      if (activeButtonName === "Talk Button") {
        handleTalkEnd();
      }
      releaseButtons(false);
    }

    resize();
    window.addEventListener("resize", resize);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    renderer.domElement.addEventListener("pointercancel", onPointerCancel);
    renderer.domElement.addEventListener("contextmenu", suppressNativeContextMenu);

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const time = performance.now() / 1000;
      const led = ledVisual(ledStateRef.current, time);
      const ledMaterial = ledMesh.material as THREE.MeshStandardMaterial;
      const ledGlowMaterial = ledGlow.material as THREE.SpriteMaterial;
      ledMaterial.color.setHex(led.color);
      ledMaterial.emissive.setHex(led.color);
      ledMaterial.emissiveIntensity = led.intensity;
      ledGlowMaterial.color.setHex(led.color);
      ledGlowMaterial.opacity += (led.glow - ledGlowMaterial.opacity) * 0.18;
      const glowScale = 0.22 + led.glow * 0.12;
      ledGlow.scale.set(glowScale, glowScale, 1);

      buttons.forEach((button) => {
        button.currentPress += (button.targetPress - button.currentPress) * 0.22;
        const pressDepth = button.name === "Next Step" ? 0.16 : 0.09;
        button.ring.position.z = button.ringBaseZ - button.currentPress * pressDepth;
        button.core.position.z = button.coreBaseZ - button.currentPress * (pressDepth + 0.02);
      });

      controls.update();
      cameraPoseRef.current.position.copy(camera.position);
      cameraPoseRef.current.target.copy(controls.target);
      setCameraReadout((current) => {
        const next = {
          position: {
            x: Number(camera.position.x.toFixed(3)),
            y: Number(camera.position.y.toFixed(3)),
            z: Number(camera.position.z.toFixed(3))
          },
          target: {
            x: Number(controls.target.x.toFixed(3)),
            y: Number(controls.target.y.toFixed(3)),
            z: Number(controls.target.z.toFixed(3))
          }
        };
        return JSON.stringify(current) === JSON.stringify(next) ? current : next;
      });
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      renderer.domElement.removeEventListener("pointercancel", onPointerCancel);
      renderer.domElement.removeEventListener("contextmenu", suppressNativeContextMenu);
      controls.dispose();
      if (mountEl.contains(renderer.domElement)) mountEl.removeChild(renderer.domElement);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) object.material.forEach((m) => m.dispose());
          else object.material.dispose();
        }
        if (object instanceof THREE.Sprite) {
          object.material.map?.dispose();
          object.material.dispose();
        }
      });
      renderer.dispose();
    };
  }, [cameraUnlocked, handleTalkStart, handleTalkEnd, sendNextStep, useFallback]);

  const micHelpText =
    micPermissionState === "unknown"
      ? "First use on iPhone: tap Talk once, allow microphone access, then press and hold to record."
      : micPermissionState === "requesting"
        ? "Waiting for microphone permission. After you allow it, press and hold Talk again."
        : micPermissionState === "denied"
          ? "Microphone access is blocked. In Safari, enable the mic for this site and try again."
          : micPermissionState === "unavailable"
            ? "The microphone isn’t available right now. Check your device and try again."
            : "Press and hold Talk while you speak. Release to send.";

  return (
    <main className={styles.page}>
      <audio ref={audioRef} preload="auto" playsInline className={styles.hiddenAudio} />

      <div className={styles.headerWrap}>
        <button
          type="button"
          className={styles.cameraToggleButton}
          onClick={() => setCameraUnlocked((value) => !value)}
          aria-pressed={cameraUnlocked}
        >
          {cameraUnlocked ? "Lock Camera" : "Unlock Camera"}
        </button>
        <div className={styles.header}>
          <h1>Voice Cooking Companion</h1>
          <p>Status: {cameraUnlocked ? "Camera unlocked — drag to orbit" : statusText}</p>
          <p>{cameraUnlocked ? "Camera mode is on. Hardware buttons are temporarily disabled." : micHelpText}</p>
          {cameraUnlocked ? (
            <>
              <p className={styles.axisHint}>CAD axes overlay: X red = left/right, Y green = depth, Z blue = up. Short ticks mark 1 mm-style steps; longer ticks mark 1 cm-style steps.</p>
              <div className={styles.cameraReadout}>
                <div><strong>Camera pos</strong>: ({cameraReadout.position.x}, {cameraReadout.position.y}, {cameraReadout.position.z})</div>
                <div><strong>Target</strong>: ({cameraReadout.target.x}, {cameraReadout.target.y}, {cameraReadout.target.z})</div>
              </div>
            </>
          ) : null}
          {lastAnswerText ? <p className={styles.answerText}>Last response: {lastAnswerText}</p> : null}
          {pendingAudioUrl ? (
            <button type="button" className={styles.playResponseButton} onClick={() => void handleManualPlay()}>
              Play Response
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.sceneWrap} onContextMenu={suppressLongPress}>
        {useFallback ? (
          <>
            <FallbackDevice
              ledState={ledState}
              onMainPress={() => {
                if (!cameraUnlocked) void sendNextStep();
              }}
              onTalkStart={() => {
                if (!cameraUnlocked) void handleTalkStart();
              }}
              onTalkEnd={() => {
                if (!cameraUnlocked) handleTalkEnd();
              }}
            />
            <div className={`${styles.label} ${styles.mainLabel}`}>Next Step</div>
            <div className={`${styles.label} ${styles.talkLabel}`}>Talk Button</div>
          </>
        ) : (
          <>
            <div ref={mountRef} className={styles.scene} aria-label="3D simulated hardware device" />
            <div style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
              <button type="button" onClick={() => { if (!cameraUnlocked) void sendNextStep(); }} aria-label="Next Step">
                Next Step
              </button>
              <button
                type="button"
                onPointerDown={() => { if (!cameraUnlocked) void handleTalkStart(); }}
                onPointerUp={() => { if (!cameraUnlocked) handleTalkEnd(); }}
                onPointerCancel={() => { if (!cameraUnlocked) handleTalkEnd(); }}
                onPointerLeave={() => { if (!cameraUnlocked) handleTalkEnd(); }}
                aria-label="Talk Button"
              >
                Talk Button
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
