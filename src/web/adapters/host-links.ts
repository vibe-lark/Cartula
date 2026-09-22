/** Route anchor gestures through the Host, including links inside dialogs. */
export function installHostLinks(options: {
  baseUrl: () => string | undefined;
  open: (url: string) => Promise<void>;
  onError: (url: string, message: string) => void;
}) {
  const follow = (event: MouseEvent) => {
    if (event.defaultPrevented || (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0)) return;
    const target = event.target;
    const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download')) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    event.preventDefault();
    let url: URL;
    try {
      url = new URL(href, options.baseUrl());
      if (!['https:', 'http:'].includes(url.protocol)) return;
    } catch { options.onError(href, '暂时无法确定链接地址，请等待地图加载后重试。'); return; }
    void options.open(url.href).catch(error => options.onError(url.href, error instanceof Error ? error.message : '宿主未能打开链接，请复制地址。'));
  };
  document.addEventListener('click', follow, true);
  document.addEventListener('auxclick', follow, true);
  return () => {
    document.removeEventListener('click', follow, true);
    document.removeEventListener('auxclick', follow, true);
  };
}
