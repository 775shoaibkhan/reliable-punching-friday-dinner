RELIABLE PUNCHING - FRIDAY DINNER ANDROID

This folder is build-ready for GitHub Actions.
1) Upload this folder to a PRIVATE GitHub repository.
2) GitHub -> Actions -> Build Android APK -> Run workflow.
3) Download artifact: Reliable-Punching-Friday-Dinner-APK.
4) Install Reliable-Punching-Friday-Dinner.apk on Android.

The signing key is intentionally included so every future APK is signed with the same key and can update the already-installed private app. Keep the GitHub repository PRIVATE and do not share the signing folder publicly.

Website/backend changes are loaded live in the WebView and normally do not require a new APK. Native reminder/app-code changes require a new APK build.

BACKEND:
The backend folder contains the matching Index.html and Code.gs. Deploy those to the existing Google Apps Script project before testing native reminder cancellation / Android update checking.
