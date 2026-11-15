import express from 'express';

/**
 * Built-in Demo Video Server (/demo-server)
 * Serves a genuine multi-page HTML Video Portal AND an Apache-style Open Directory
 * so users can test full server crawling & remote-friendly browsing immediately,
 * or enter any external website/server URL of their choice.
 */
export function createDemoServerRouter(): express.Router {
  const router = express.Router();

  const svgPoster = (title: string, subtitle: string, accent: string, bg: string) => `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${bg}" />
          <stop offset="100%" stop-color="#090A0F" />
        </linearGradient>
      </defs>
      <rect width="640" height="360" fill="url(#g)" />
      <circle cx="540" cy="70" r="140" fill="${accent}" opacity="0.14" />
      <rect x="36" y="246" width="56" height="4" rx="2" fill="${accent}" />
      <text x="36" y="288" fill="#F8FAFC" font-family="system-ui, sans-serif" font-size="28" font-weight="700">${escapeXml(title)}</text>
      <text x="36" y="318" fill="#94A3B8" font-family="system-ui, sans-serif" font-size="16">${escapeXml(subtitle)}</text>
    </svg>
  `.trim();

  function escapeXml(str: string): string {
    return str.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
        default: return c;
      }
    });
  }

  const catalog = [
    {
      slug: 'big-buck-bunny',
      title: 'Big Buck Bunny (1080p)',
      category: 'animacoes',
      categoryLabel: 'Animações',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      poster: '/demo-server/posters/bunny.svg',
      description: 'Curta-metragem de animação em 3D produzido pela Fundação Blender.',
      accent: '#38BDF8',
      bg: '#111D2E',
      size: '158 MB',
    },
    {
      slug: 'sintel',
      title: 'Sintel — A Jornada do Dragão',
      category: 'animacoes',
      categoryLabel: 'Animações',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
      poster: '/demo-server/posters/sintel.svg',
      description: 'Uma jovem guerreira atravessa montanhas geladas em busca de um dragão perdido.',
      accent: '#F59E0B',
      bg: '#231710',
      size: '194 MB',
    },
    {
      slug: 'elephants-dream',
      title: 'Elephants Dream',
      category: 'animacoes',
      categoryLabel: 'Animações',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
      poster: '/demo-server/posters/elephants.svg',
      description: 'Dois personagens exploram uma máquina colossal e surreal de fios e engrenagens.',
      accent: '#A78BFA',
      bg: '#1A162A',
      size: '142 MB',
    },
    {
      slug: 'tears-of-steel',
      title: 'Tears of Steel (4K)',
      category: 'filmes',
      categoryLabel: 'Filmes e Ficção',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
      poster: '/demo-server/posters/tears.svg',
      description: 'Em uma Amsterdã futurista, um grupo de cientistas tenta conter robôs inteligentes.',
      accent: '#38BDF8',
      bg: '#0E1924',
      size: '312 MB',
    },
    {
      slug: 'for-bigger-escapes',
      title: 'Horizontes — Grandes Fugas',
      category: 'filmes',
      categoryLabel: 'Filmes e Ficção',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
      poster: '/demo-server/posters/escapes.svg',
      description: 'Produção cinematográfica de aventura e ação em alta definição.',
      accent: '#F43F5E',
      bg: '#25121A',
      size: '84 MB',
    },
    {
      slug: 'for-bigger-blazes',
      title: 'Chamas na Montanha',
      category: 'documentarios',
      categoryLabel: 'Documentários',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      poster: '/demo-server/posters/blazes.svg',
      description: 'Documentário visual sobre expedições extremas e fotografia de natureza.',
      accent: '#F97316',
      bg: '#24150E',
      size: '92 MB',
    },
    {
      slug: 'subaru-expedicao',
      title: 'Estradas Selvagens — Expedição',
      category: 'documentarios',
      categoryLabel: 'Documentários',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4',
      poster: '/demo-server/posters/expedicao.svg',
      description: 'Travessia off-road por trilhas de terra, cânions e rodovias costeiras.',
      accent: '#10B981',
      bg: '#0D211B',
      size: '115 MB',
    },
    {
      slug: 'mux-hls-stream',
      title: 'Canal Demo HLS (Adaptativo)',
      category: 'ao-vivo',
      categoryLabel: 'Transmissões HLS',
      videoUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      poster: '/demo-server/posters/hls.svg',
      description: 'Transmissão de teste em formato M3U8 adaptativo para validação de streaming.',
      accent: '#22D3EE',
      bg: '#0D1E26',
      size: 'HLS',
    },
  ];

  // Serve SVG posters
  router.get('/posters/:file', (req, res) => {
    const item = catalog.find((c) => c.poster.endsWith('/' + req.params.file));
    res.setHeader('Content-Type', 'image/svg+xml');
    if (!item) {
      res.send(svgPoster('Acervo de Vídeo', 'Servidor Local', '#38BDF8', '#12151E'));
      return;
    }
    res.send(svgPoster(item.title, item.categoryLabel, item.accent, item.bg));
  });

  // Root HTML Video Portal
  router.get('/', (_req, res) => {
    const categories = Array.from(new Set(catalog.map((c) => c.category)));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="pt-BR">
<head><title>CineAcervo — Servidor de Vídeos</title></head>
<body>
  <h1>CineAcervo — Portal de Vídeos</h1>
  <nav>
    ${categories.map((cat) => `<a href="/demo-server/${cat}/">${cat}</a>`).join(' | ')}
    <a href="/demo-server/diretorio/">Diretório Bruto</a>
  </nav>
  <main>
    ${catalog.map((item) => `
      <article class="video-card">
        <a href="/demo-server/${item.category}/${item.slug}.html" data-category="${item.categoryLabel}">
          <img src="${item.poster}" alt="${item.title}" />
          <h3>${item.title}</h3>
        </a>
      </article>
    `).join('\n')}
  </main>
</body>
</html>`);
  });

  // Category folders
  router.get('/:category/', (req, res, next) => {
    const cat = req.params.category;
    if (cat === 'diretorio') return next();
    const items = catalog.filter((c) => c.category === cat);
    if (items.length === 0) return next();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="pt-BR">
<head><title>${items[0].categoryLabel} — CineAcervo</title></head>
<body>
  <h1>${items[0].categoryLabel}</h1>
  ${items.map((item) => `
    <article class="video-card">
      <a href="/demo-server/${item.category}/${item.slug}.html">
        <img src="${item.poster}" alt="${item.title}" />
        <h3>${item.title}</h3>
      </a>
    </article>
  `).join('\n')}
</body>
</html>`);
  });

  // Individual video pages
  router.get('/:category/:slug.html', (req, res, next) => {
    const item = catalog.find((c) => c.category === req.params.category && c.slug === req.params.slug);
    if (!item) return next();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="pt-BR">
<head>
  <title>${item.title}</title>
  <meta property="og:title" content="${item.title}" />
  <meta property="og:description" content="${item.description}" />
  <meta property="og:image" content="${item.poster}" />
</head>
<body>
  <h1>${item.title}</h1>
  <p>${item.description}</p>
  <video controls poster="${item.poster}" title="${item.title}">
    <source src="${item.videoUrl}" />
  </video>
</body>
</html>`);
  });

  // Apache-style Open Directory Index (/demo-server/diretorio/)
  router.get('/diretorio/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html>
<head><title>Index of /acervo/</title></head>
<body>
<h1>Index of /acervo/</h1>
<pre>
<a href="../">../</a>
<a href="/demo-server/diretorio/Filmes/">Filmes/</a>                                     14-Nov-2026 12:00    -
<a href="/demo-server/diretorio/Animacoes/">Animacoes/</a>                               14-Nov-2026 12:00    -
<a href="/demo-server/diretorio/Documentarios/">Documentarios/</a>                       14-Nov-2026 12:00    -
<a href="/demo-server/diretorio/AoVivo/">AoVivo/</a>                                     14-Nov-2026 12:00    -
</pre>
</body>
</html>`);
  });

  const dirMap: Record<string, string> = {
    Filmes: 'filmes',
    Animacoes: 'animacoes',
    Documentarios: 'documentarios',
    AoVivo: 'ao-vivo',
  };

  router.get('/diretorio/:folder/', (req, res, next) => {
    const mapped = dirMap[req.params.folder];
    if (!mapped) return next();
    const items = catalog.filter((c) => c.category === mapped);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html>
<head><title>Index of /acervo/${req.params.folder}/</title></head>
<body>
<h1>Index of /acervo/${req.params.folder}/</h1>
<pre>
<a href="/demo-server/diretorio/">../</a>
${items.map((item) => `<a href="${item.videoUrl}">${item.slug}.${item.videoUrl.endsWith('.m3u8') ? 'm3u8' : 'mp4'}</a>           14-Nov-2026 14:20   ${item.size}`).join('\n')}
</pre>
</body>
</html>`);
  });

  return router;
}
