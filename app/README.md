# Agent Chat — native app (Capacitor)

Capacitor shell around the Agent Chat web app. The authoritative guide is
the repo's root `AGENTS.md`, section 11 — this file is only a status card.

## Current state (2026-11-07)

- **Design:** `server.url` points the shell at https://chat.victorio.cloud —
  the site IS the app (home, rooms, identity in site storage). The bundled
  page is the offline/error fallback and a diagnostics bench.
- **Phases 0–3 are done and proven on-device:** shell + identity (v11),
  FCM push (v15, Firebase project `agent-chat-87861`), background uploads
  with server-side publish-on-complete (v18 — a 282 MB video posted through
  the chunked path with the phone locked). The one path not yet exercised
  on a device is the 25–100 MB stream leg inside the real composer.
- **Current build:** v18 (SHA-256 76B49D36…). `versionCode`/`versionName`
  in `app/android/app/build.gradle` track the build number — bump them
  with every build.
- **Builds run on Anthony's Legion** (`C:\Users\operator\build-apk.ps1`,
  JDK 21 + Android SDK 36); agent VMs can't build (process supervision
  kills Gradle). Files cross via scp over the Tailscale SSH route.
- **Parked:** the iOS leg — waits on a Mac build machine (MacStadium,
  Anthony to order) and Apple Developer enrollment. APNs slots into the
  existing per-platform push registry when it lands.
- **Plugins:** @capgo/capacitor-uploader (whole-file background PUTs),
  @capawesome/capacitor-file-picker (native picks), @capacitor/app (deep
  links), @capacitor/push-notifications, @capacitor/filesystem,
  @capacitor/splash-screen, @capacitor/status-bar, plus the in-app
  ChunkedUploader plugin (foreground service, fingerprint resume).
  Pitfall: Capacitor's PluginCall.getLong silently zeroes ordinary file
  sizes — read numeric args as raw Numbers (see root AGENTS.md section 3).

## Build

Needs JDK 21 + Android SDK 36 (compileSdk 36). JAVA_HOME must point at JDK
21: one of the Capacitor plugin modules (capacitor-filesystem) declares a
Java 21 toolchain, so a JDK 17-only machine fails the Gradle build even
though Gradle itself runs on 17.

    cd app
    npm install
    npm run build           # vite -> dist
    npx cap sync android
    cd android && ./gradlew assembleDebug
    # APK: android/app/build/outputs/apk/debug/app-debug.apk

`src/spike-config.js` (git-ignored) carries the THROWAWAY test room's invite
token for the diagnostics bench; copy `src/spike-config.example.js` and
fill it in.
