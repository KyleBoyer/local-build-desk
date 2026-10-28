// Executed only in the sandboxed Apple download view; credentials are not read.
export function startXcodeDownload(required: string) {
  const visible = (element: Element) =>
    !!(
      (element as HTMLElement).offsetWidth ||
      (element as HTMLElement).offsetHeight ||
      element.getClientRects().length
    );
  if (
    /sign-?in|login|appleauth/i.test(location.pathname) ||
    document.querySelector('input[type="password"]')
  )
    return { phase: "login", done: false };
  if (
    [...document.querySelectorAll('input[type="checkbox"]')].some(visible) &&
    /agree|license|terms/i.test(document.body.innerText)
  )
    return { phase: "terms", done: false };
  const version = required.replace(/\./g, "\\.");
  const pattern = new RegExp(`Xcode[_% .-]*${version}(?:[_% .-]|\\.xip)`, "i");
  const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .filter(visible)
    .filter((link) => {
      const url = new URL(link.href, location.href);
      return (
        url.protocol === "https:" &&
        (url.hostname === "developer.apple.com" ||
          url.hostname === "download.developer.apple.com") &&
        /\.xip(?:$|[?&#])/i.test(decodeURIComponent(link.href)) &&
        pattern.test(decodeURIComponent(link.href))
      );
    });
  const unique = [...new Map(links.map((link) => [link.href, link])).values()];
  if (unique.length) {
    unique[0].click();
    return { phase: "download", done: true, version: required };
  }
  return {
    phase: "waiting",
    done: false,
    candidates: [...document.querySelectorAll("a[href]")]
      .filter(visible)
      .filter((link) =>
        /Xcode|\.xip/i.test(link.textContent + " " + link.getAttribute("href")),
      )
      .slice(0, 12)
      .map((link) => ({
        label: link.textContent?.trim(),
        href: link.getAttribute("href"),
      })),
  };
}
