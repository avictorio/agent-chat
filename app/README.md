# Agent Chat — native app (Capacitor)

Capacitor shell around the Agent Chat web app. Phase 0 (spike) state as of
2026-11-06: project scaffolded, Android platform added, plugins synced, and
the spike page (launcher + background-upload fit test + push check) built.
The server side it tests against — `PUT /messages/:id/video/stream`, the
whole-file streaming ingest — is live in production.

## Plugins (Phase 0 findings)

- `@capgo/capacitor-uploader` — the background uploader. Verified from its
  API: `startUpload({ filePath, serverUrl, method: "PUT", headers })` with
  progress/completion events; iOS uses a background URLSession, Android a
  foreground upload service (gotev UploadService, dataSync type). It sends
  WHOLE files, not byte ranges — hence the streaming ingest endpoint.
- `@capacitor/filesystem` — builds the spike's 30 MB test file and provides
  real file paths for the uploader.
- `@capacitor/push-notifications` — wired in; registration will fail until
  Firebase/APNs exist (Phase 2), which the spike page states.

## Build

Needs JDK 17 + Android SDK 36 (compileSdk 36):

    cd app
    npm install
    npm run build           # vite -> dist
    npx cap sync android
    cd android && ./gradlew assembleDebug
    # APK: android/app/build/outputs/apk/debug/app-debug.apk

`src/spike-config.js` (git-ignored) carries the THROWAWAY test room's invite
token for the fit test; copy `src/spike-config.example.js` and fill it in.

## Why there is no APK from Ada's VM (2026-11-06)

The VM's process supervision kills the Gradle daemon seconds after it
starts (daemon log: greeting written, then "STOPPED (by user or operating
system)") — across foreground, --no-daemon, and tracked background
launches. Gradle cannot build without its daemon, so APKs must be built on
a normal machine (Anthony's Legion, Android Studio anywhere) or a cloud
build (Capgo / EAS-style). sdkmanager also cannot use this VM's egress
proxy (Java CONNECT parsing); the SDK at ~/android-sdk was laid out by
hand from the dl.google.com zips, and Gradle 8.14.3 sits at ~/gradle-dist —
both persist in the home directory if the VM is replaced, but they do not
remove the daemon constraint.

## Spike test (on device)

1. Install the debug APK, open "Agent Chat".
2. Section 1: paste your real invite link, open the room in the shell.
3. Section 2: Run the fit test, then switch apps / lock the phone for a
   minute. The event log (persisted) should show the upload completing
   while the app was backgrounded; the page then verifies the message
   server-side and publishes it into the throwaway room.
