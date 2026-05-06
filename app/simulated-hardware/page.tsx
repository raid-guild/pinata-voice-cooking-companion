"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import styles from "./simulated-hardware.module.css";

type LedState = "off" | "booting" | "connecting" | "ready" | "recording" | "thinking" | "playing" | "error";

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
  const errorResetTimeoutRef = useRef<number | null>(null);
  const [useFallback, setUseFallback] = useState(false);
  const [ledState, setLedState] = useState<LedState>("ready");
  const [statusText, setStatusText] = useState("Ready");

  const sessionId = useMemo(() => getOrCreateSessionId(), []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    ledStateRef.current = ledState;
    setStatusText(ledLabel(ledState));
  }, [ledState]);

  const setErrorState = useCallback((message: string) => {
    if (errorResetTimeoutRef.current) window.clearTimeout(errorResetTimeoutRef.current);
    setStatusText(message);
    setLedState("error");
    errorResetTimeoutRef.current = window.setTimeout(() => {
      setLedState("ready");
      setStatusText("Ready");
      errorResetTimeoutRef.current = null;
    }, 1800);
  }, []);

  const stopMediaTracks = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const playResponseAudio = useCallback(
    async (audioUrl: string | undefined) => {
      if (!audioUrl || !audioRef.current) {
        setLedState("ready");
        return;
      }

      const resolvedUrl = audioUrl.startsWith("http") ? audioUrl : new URL(audioUrl, window.location.origin).toString();
      audioRef.current.src = resolvedUrl;
      setLedState("playing");
      try {
        await audioRef.current.play();
      } catch {
        setErrorState("Couldn’t play response audio");
      }
    },
    [setErrorState]
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
      if (!response.ok || !result.ok) throw new Error(result.answerText || "Next step failed.");
      await playResponseAudio(result.audio?.url);
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
        const formData = new FormData();
        const normalizedType = (blob.type || "audio/webm").split(";")[0]?.trim().toLowerCase() || "audio/webm";
        const extension = normalizedType === "audio/mpeg"
          ? "mp3"
          : normalizedType === "audio/mp4" || normalizedType === "audio/x-m4a"
            ? "m4a"
            : normalizedType === "audio/wav"
              ? "wav"
              : normalizedType === "audio/ogg"
                ? "ogg"
                : "webm";
        formData.append("audio", new File([blob], `query-audio.${extension}`, { type: normalizedType }));
        formData.append("sessionId", sessionIdRef.current);

        const response = await fetch("/app/query-audio", {
          method: "POST",
          body: formData
        });
        const result = (await response.json()) as AudioQueryResponse;
        if (result.session?.id) sessionIdRef.current = result.session.id;
        if (!response.ok || !result.ok) throw new Error(result.answerText || "Audio query failed.");
        await playResponseAudio(result.audio?.url);
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
    talkActiveRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];

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
        stopMediaTracks();
        mediaRecorderRef.current = null;
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        audioChunksRef.current = [];
        if (blob.size > 0) {
          await uploadRecording(blob);
        } else {
          setLedState("ready");
          setStatusText("Ready");
        }
      });

      recorder.start();
      setLedState("recording");
      setStatusText("Recording");
    } catch {
      stopMediaTracks();
      talkActiveRef.current = false;
      setErrorState("Microphone access was denied");
    }
  }, [setErrorState, stopMediaTracks, uploadRecording]);

  const handleTalkEnd = useCallback(() => {
    if (!talkActiveRef.current) return;
    talkActiveRef.current = false;

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }

    stopMediaTracks();
  }, [stopMediaTracks]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleEnded = () => {
      setLedState("ready");
      setStatusText("Ready");
    };

    const handleError = () => {
      setErrorState("Response audio failed to play");
    };

    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);
    return () => {
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };
  }, [setErrorState]);

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
    camera.position.set(0.45, 2.35, 10.6);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mountEl.appendChild(renderer.domElement);

    const ambient = new THREE.HemisphereLight(0xffffff, 0x9a7b56, 1.35);
    scene.add(ambient);

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
    group.position.y = 0.7;
    group.rotation.x = -0.22;
    group.rotation.y = -0.55;
    group.rotation.z = -0.04;
    scene.add(group);

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(4.6, 3.2, 3.1),
      new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.88, metalness: 0.06 })
    );
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const topHighlight = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 2.7),
      new THREE.MeshBasicMaterial({ color: 0x2b2d31, transparent: true, opacity: 0.42 })
    );
    topHighlight.position.set(0, 1.61, 0);
    topHighlight.rotation.x = -Math.PI / 2;
    group.add(topHighlight);

    const ledMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 24, 24),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: 0x000000, emissiveIntensity: 0 })
    );
    ledMesh.position.set(1.45, 1.02, 1.58);
    group.add(ledMesh);

    const ledGlowTexture = createLedGlowTexture();
    const ledGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: ledGlowTexture, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })
    );
    ledGlow.position.copy(ledMesh.position);
    ledGlow.scale.set(0.28, 0.28, 1);
    group.add(ledGlow);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(6.5, 48),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.22 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.85;
    floor.receiveShadow = true;
    scene.add(floor);

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

    const mainButton = buildButton("Next Step", 0.7, 0.92, 0.36);
    mainButton.group.position.set(-0.92, 0.02, 1.6);
    group.add(mainButton.group);
    clickable.push(mainButton.hitArea);
    buttons.push(mainButton);

    const talkButton = buildButton("Talk Button", 0.28, 0.4, 0.16);
    talkButton.group.position.set(2.34, -0.18, 0.66);
    talkButton.group.rotation.y = -Math.PI / 2;
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
      setPointer(event);
      const hit = raycaster.intersectObjects(clickable, false);
      renderer.domElement.style.cursor = hit.length ? "pointer" : "default";
    }

    function onPointerDown(event: PointerEvent) {
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
      releaseButtons(true);
    }

    function onPointerLeave() {
      if (activeButtonName === "Talk Button") {
        handleTalkEnd();
      }
      releaseButtons(false);
    }

    function onPointerCancel() {
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
  }, [handleTalkStart, handleTalkEnd, sendNextStep, useFallback]);

  return (
    <main className={styles.page}>
      <audio ref={audioRef} preload="auto" className={styles.hiddenAudio} />

      <div className={styles.header}>
        <h1>Voice Cooking Companion</h1>
        <p>Status: {statusText}</p>
      </div>

      <div className={styles.sceneWrap} onContextMenu={suppressLongPress}>
        {useFallback ? (
          <FallbackDevice ledState={ledState} onMainPress={() => void sendNextStep()} onTalkStart={() => void handleTalkStart()} onTalkEnd={handleTalkEnd} />
        ) : (
          <>
            <div ref={mountRef} className={styles.scene} aria-label="3D simulated hardware device" />
            <div style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
              <button type="button" onClick={() => void sendNextStep()} aria-label="Next Step">
                Next Step
              </button>
              <button
                type="button"
                onPointerDown={() => void handleTalkStart()}
                onPointerUp={handleTalkEnd}
                onPointerCancel={handleTalkEnd}
                onPointerLeave={handleTalkEnd}
                aria-label="Talk Button"
              >
                Talk Button
              </button>
            </div>
          </>
        )}
        <div className={`${styles.label} ${styles.mainLabel}`}>Next Step</div>
        <div className={`${styles.label} ${styles.talkLabel}`}>Talk Button</div>
      </div>
    </main>
  );
}
