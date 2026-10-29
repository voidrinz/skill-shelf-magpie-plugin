(async () => {
  const theme = await magpie.ready;
  const deadline = Date.now() + 30_000;
  function connect() {
    const script = document.createElement('script');
    script.src = `connection.js?t=${Date.now()}`;
    script.onload = () => {
      const target = new URL(window.skillShelfConnection);
      target.searchParams.set('theme', theme.dark ? 'dark' : 'light');
      location.replace(target.href);
    };
    script.onerror = () => {
      script.remove();
      if (Date.now() < deadline) setTimeout(connect, 500);
      else document.getElementById('status').textContent = '无法连接书架，请关闭并重新启用 Skill Shelf 插件。';
    };
    document.head.append(script);
  }
  connect();
})();
