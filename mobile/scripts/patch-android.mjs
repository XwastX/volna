// Донастройка android-проекта после «npx cap add android»: иконки, разрешения, версия, фоновое воспроизведение.
import { cpSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = join(root, "android", "app");
if (!existsSync(app)) { console.error("Нет папки android — сначала npx cap add android"); process.exit(1); }
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cfg = JSON.parse(readFileSync(join(root, "capacitor.config.json"), "utf8"));

// 1. иконки и заставка
cpSync(join(root, "resources", "android", "res"), join(app, "src", "main", "res"), { recursive: true });

// 2. разрешения: фоновое воспроизведение с уведомлением
const manPath = join(app, "src", "main", "AndroidManifest.xml");
let man = readFileSync(manPath, "utf8");
for (const perm of ["FOREGROUND_SERVICE", "FOREGROUND_SERVICE_MEDIA_PLAYBACK", "POST_NOTIFICATIONS", "WAKE_LOCK"]) {
  if (!man.includes(`android.permission.${perm}"`)) man = man.replace("</manifest>", `    <uses-permission android:name="android.permission.${perm}" />\n</manifest>`);
}
writeFileSync(manPath, man);

// 3. версия приложения
const [ma, mi, pa] = pkg.version.split(".").map(Number);
const gradlePath = join(app, "build.gradle");
let g = readFileSync(gradlePath, "utf8");
g = g.replace(/versionCode \d+/, `versionCode ${ma * 10000 + mi * 100 + pa}`).replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);
// подпись релиза постоянным ключом (из секретов GitHub): иначе новая версия не встанет поверх старой
if (!g.includes("VOLNA_KEYSTORE")) {
  g = g.replace(/android \{/, `android {
    signingConfigs {
        volna {
            if (System.getenv("VOLNA_KEYSTORE")) {
                storeFile file(System.getenv("VOLNA_KEYSTORE"))
                storePassword System.getenv("VOLNA_KEYSTORE_PASSWORD")
                keyAlias "volna"
                keyPassword System.getenv("VOLNA_KEYSTORE_PASSWORD")
            }
        }
    }`);
  g = g.replace(/release \{\s*\n(\s*)minifyEnabled false/, (m, sp) => `release {\n${sp}signingConfig System.getenv("VOLNA_KEYSTORE") ? signingConfigs.volna : signingConfigs.debug\n${sp}minifyEnabled false`);
}
writeFileSync(gradlePath, g);
const varsPath = join(root, "android", "variables.gradle");
writeFileSync(varsPath, readFileSync(varsPath, "utf8").replace(/minSdkVersion = \d+/, "minSdkVersion = 26"));

// 4. MainActivity: звук без жеста (следующий трек в фоне запускается сам)
const javaRoot = join(app, "src", "main", "java");
const findMain = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) { const r = findMain(p); if (r) return r; } else if (f === "MainActivity.java") return p; } return null; };
const mainPath = findMain(javaRoot);
if (mainPath) {
  writeFileSync(mainPath, `package ${cfg.appId};

import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebSettings s = bridge.getWebView().getSettings();
        s.setMediaPlaybackRequiresUserGesture(false);
    }

    @Override
    public void onPause() {
        super.onPause();
        // не останавливаем WebView: музыка должна играть со свёрнутым приложением
        bridge.getWebView().onResume();
        bridge.getWebView().resumeTimers();
    }
}
`);
}
console.log("android проект настроен:", pkg.version);
