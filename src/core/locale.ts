/**
 * Native build tools need a UTF-8 locale: CocoaPods stops with
 * "Unicode Normalization not appropriate for ASCII-8BIT" without one. Apps
 * opened from Finder or the Dock get no LANG, so a background owner started
 * that way would otherwise run every forwarded build without a locale.
 */
export const DEFAULT_LOCALE = "en_US.UTF-8";

/** A full UTF-8 locale name such as en_US.UTF-8, de_DE.utf8 or sr_RS.UTF-8@latin. */
export const UTF8_LOCALE =
  /^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?\.(?:UTF-8|utf8)(?:@[A-Za-z0-9]+)?$/;

/**
 * The first full UTF-8 locale among LC_ALL, LC_CTYPE and LANG (the order
 * setlocale reads them). macOS terminals often set a bare LC_CTYPE=UTF-8,
 * which names no language and is skipped in favour of LANG.
 */
export function utf8LocaleOf(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ["LC_ALL", "LC_CTYPE", "LANG"]) {
    const value = env[name];
    if (value && UTF8_LOCALE.test(value)) return value;
  }
  return undefined;
}

/** LANG and LC_ALL for native tools: the run's locale, else this process's, else en_US.UTF-8. */
export function buildLocale(
  requested?: string,
  env: NodeJS.ProcessEnv = process.env,
): { LANG: string; LC_ALL: string } {
  const locale =
    (requested && UTF8_LOCALE.test(requested) ? requested : undefined) ??
    utf8LocaleOf(env) ??
    DEFAULT_LOCALE;
  return { LANG: locale, LC_ALL: locale };
}
