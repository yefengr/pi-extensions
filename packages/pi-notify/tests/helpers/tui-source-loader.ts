import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

let installed = false;

/**
 * 测试加载钩子：仅在本包 src/ 内的相对 "./x.js" 无法解析且同名 .ts 存在时回退到 .ts。
 * 生产源码保持 .js 说明符；Node strip-only 测试运行时由此桥接。
 */
export function installTuiSourceLoader(): void {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL ?? "";
      const inPackageSrc = parent.includes("/packages/pi-notify/src/");
      if (!inPackageSrc || !specifier.startsWith(".") || !specifier.endsWith(".js")) {
        return nextResolve(specifier, context);
      }
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
        const candidate = new URL(specifier.replace(/\.js$/, ".ts"), parent);
        if (!existsSync(fileURLToPath(candidate))) throw error;
        return { url: candidate.href, shortCircuit: true };
      }
    },
  });
}
