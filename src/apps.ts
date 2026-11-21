import type { App } from './store.ts';

/** jeep-obd2: Flutter Android app. Registered with `npm run cli -- app:jeep`. */
export const JEEP_OBD2: App = {
  slug: 'jeep-obd2',
  name: 'Jeep OBD2',
  repoUrl: 'git@github.com:iam-oov/jeep-obd2.git',
  branch: 'main',
  allowedPaths: ['lib/', 'test/', 'assets/'],
  protectedPaths: ['lib/core/', 'test/core/', 'lib/main.dart'],
  prepareCmd: 'flutter pub get',
  testCmd: 'flutter analyze --no-pub --no-fatal-infos && flutter test --no-pub',
  // Public APK: no API keys compiled in; users enter theirs in the app.
  buildCmd: 'flutter build apk --release --target-platform android-arm64',
  apkPath: 'build/app/outputs/flutter-apk/app-release.apk',
};
