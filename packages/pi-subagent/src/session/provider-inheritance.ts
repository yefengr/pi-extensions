/**
 * 将父会话运行时注册的 provider 复制到子会话独立的 model runtime。
 *
 * Pi 的 provider 注册保存在 ModelRuntime 实例内，不会写入 models.json；
 * 子会话创建独立 runtime 时必须显式继承，否则自定义 provider 无法工作。
 */

/** 枚举会话运行时注册的 provider。 */
export interface RegisteredProviderSource<TNative, TConfig> {
  getRegisteredProviderIds(): readonly string[];
  getRegisteredNativeProvider(id: string): TNative | undefined;
  getRegisteredProviderConfig(id: string): TConfig | undefined;
}

/** 接收复制后的原生或配置型 provider。 */
export interface ProviderRegistrar<TNative, TConfig> {
  registerNative(provider: TNative): void;
  registerConfigured(id: string, config: TConfig): void;
}

/**
 * 按父 registry 的枚举顺序复制全部运行时注册项。
 * 原生与配置型注册理论上互斥；异常情况下优先保留原生 provider。
 */
export function inheritRegisteredProviders<TNative, TConfig>(
  source: RegisteredProviderSource<TNative, TConfig>,
  target: ProviderRegistrar<TNative, TConfig>,
): void {
  for (const id of source.getRegisteredProviderIds()) {
    const native = source.getRegisteredNativeProvider(id);
    if (native !== undefined) {
      target.registerNative(native);
      continue;
    }
    const config = source.getRegisteredProviderConfig(id);
    if (config !== undefined) target.registerConfigured(id, config);
  }
}
