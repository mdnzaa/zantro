const CATEGORIES = ['action', 'scifi', 'comedy', 'drama', 'horror', 'animation', 'series', 'doc', 'other'];

const state = {
  config: null,
  videos: [],
  locales: {},
  view: 'home',
  selectedCategory: 'all',
  search: '',
  currentVideoIndex: -1,
  editingVideo: null,
  editBannerPath: '',
  editBannerPreviewUrl: '',
  speeds: [0.5, 0.75, 1, 1.25, 1.5, 2],
  speedIndex: 2,
  thumbQueueRunning: false,
  idleTimer: null,
  lastProgressSave: 0,
  isStream: false,
  streamBaseUrl: '',
  streamOffset: 0,
  streamDuration: 0,
  seekTimer: null
};

// SON AMBIANCE TEMPLE ZEN
function playZantroIntroSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.14, now);
    master.connect(ctx.destination);

    [
      { freq: 130.81, delay: 0.0, peak: 0.32, dur: 3.2 },
      { freq: 196.00, delay: 0.16, peak: 0.21, dur: 3.0 },
      { freq: 261.63, delay: 0.28, peak: 0.16, dur: 2.8 },
      { freq: 262.45, delay: 0.28, peak: 0.12, dur: 2.8 },
      { freq: 523.25, delay: 0.45, peak: 0.06, dur: 2.4 }
    ].forEach(({ freq, delay, peak, dur }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + delay);
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.linearRampToValueAtTime(peak, now + delay + 0.36);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
      osc.connect(gain).connect(master);
      osc.start(now + delay);
      osc.stop(now + delay + dur + 0.1);
    });
  } catch {}
}

function runIntroAnimation(onComplete) {
  const splash = document.getElementById('splash-screen');
  const clone = splash.cloneNode(true);
  clone.classList.remove('hidden', 'fade-out');
  splash.parentNode.replaceChild(clone, splash);

  if (state.config?.settings?.introSound) playZantroIntroSound();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clone.classList.add('fade-out');
    setTimeout(() => {
      clone.classList.add('hidden');
      if (onComplete) onComplete();
    }, 660);
  };

  clone.addEventListener('click', finish);
  setTimeout(finish, 2300);
}

// TRADUCTIONS & THÈMES
function t(key, vars = {}) {
  const lang = state.config?.settings?.language || 'fr';
  const dict = state.locales[lang] || state.locales.fr || {};
  let val = dict;
  for (const p of key.split('.')) val = val?.[p];
  if (typeof val !== 'string') return key;
  return val.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('.lang-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.langChoice === state.config.settings.language);
  });

  const select = document.getElementById('edit-category');
  select.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${t(`categories.${c}`)}</option>`).join('');
  renderWelcomeGreeting();
}

function renderWelcomeGreeting() {
  const banner = document.getElementById('welcome-banner');
  const textEl = document.getElementById('welcome-text');
  const initEl = document.getElementById('user-avatar-initial');
  const name = state.config?.username;
  if (name) {
    initEl.textContent = name[0].toUpperCase();
    textEl.textContent = t('welcome.greeting', { name });
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function applyTheme() {
  const mode = state.config?.settings?.theme || 'dark';
  const resolved = mode === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  document.querySelectorAll('.theme-card').forEach((c) => c.classList.toggle('active', c.dataset.themeChoice === mode));
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.config?.settings?.theme === 'auto') applyTheme();
});

// MINIATURES & FORMATS
function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} Go` : `${Math.round(bytes / (1024 * 1024))} Mo`;
}

async function generateMissingThumbnails() {
  if (state.thumbQueueRunning) return;
  state.thumbQueueRunning = true;

  for (const vid of state.videos.filter((v) => !v.thumbUrl)) {
    try {
      let savedUrl = await window.zantroAPI.makeThumb({ id: vid.id, filePath: vid.path });
      if (!savedUrl) {
        const res = await captureFrame(vid.fileUrl);
        if (res) savedUrl = await window.zantroAPI.saveThumb({ id: vid.id, dataUrl: res.dataUrl });
      }
      if (savedUrl) {
        vid.thumbUrl = savedUrl;
        if (!vid.bannerUrl) vid.bannerUrl = savedUrl;
        renderAll();
      }
    } catch {}
  }
  state.thumbQueueRunning = false;
}

function captureFrame(fileUrl) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = fileUrl;

    const cleanup = () => { video.removeAttribute('src'); video.load(); };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, 5000);

    video.onloadedmetadata = () => {
      const target = Math.min(Math.max(video.duration * 0.15, 2), 25);
      video.currentTime = isFinite(target) ? target : 1;
    };

    video.onseeked = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 225;
        canvas.getContext('2d').drawImage(video, 0, 0, 400, 225);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        cleanup();
        resolve({ dataUrl });
      } catch {
        cleanup();
        resolve(null);
      }
    };

    video.onerror = () => { clearTimeout(timer); cleanup(); resolve(null); };
  });
}

// VUES CINÉMA & GESTION
function setActiveView(view) {
  state.view = view;
  document.querySelectorAll('.nav-tab').forEach((tEl) => tEl.classList.toggle('active', tEl.dataset.view === view));

  const cinemaView = document.getElementById('cinema-view');
  const manageView = document.getElementById('manage-view');

  if (view === 'manage') {
    cinemaView.classList.add('hidden');
    manageView.classList.remove('hidden');
  } else {
    manageView.classList.add('hidden');
    cinemaView.classList.remove('hidden');
  }
  renderAll();
}

function getFilteredVideos() {
  const q = state.search.trim().toLowerCase();
  const favs = state.config.favorites || [];

  return state.videos.filter((v) => {
    if (state.view === 'favorites' && !favs.includes(v.path)) return false;
    if (state.view === 'categories' && state.selectedCategory !== 'all' && v.category !== state.selectedCategory) return false;
    if (q) {
      const match = v.title.toLowerCase().includes(q)
        || (v.actors && v.actors.toLowerCase().includes(q))
        || t(`categories.${v.category}`).toLowerCase().includes(q);
      if (!match) return false;
    }
    return true;
  });
}

function createVideoCard(vid) {
  const prog = state.config.progress[vid.path];
  const pct = prog && prog.duration ? Math.min(100, (prog.currentTime / prog.duration) * 100) : 0;
  const img = vid.bannerUrl || vid.thumbUrl;

  const card = document.createElement('div');
  card.className = 'video-card';
  card.innerHTML = `
    <div class="thumb-wrap">
      ${img ? `<img class="thumb-img" src="${img}" loading="lazy" />` : '<div class="thumb-placeholder">MP4</div>'}
      <div class="card-play-overlay">
        <div class="play-circle"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg></div>
      </div>
      ${pct > 0 ? `<div class="card-progress-track"><div class="card-progress-fill" style="width:${pct}%"></div></div>` : ''}
    </div>
    <div class="card-info">
      <div class="card-title" title="${vid.title}">${vid.title}</div>
      <div class="card-sub">
        <span>${t(`categories.${vid.category}`)}</span>
        <span>${vid.year || formatSize(vid.size)}</span>
      </div>
    </div>
  `;

  card.addEventListener('click', () => openDetailModal(vid));
  return card;
}

function renderHero() {
  const hero = document.getElementById('hero-section');
  if (state.view !== 'home' || !state.videos.length || state.search) {
    hero.classList.add('hidden');
    return;
  }

  const prog = state.config.progress || {};
  const inProgress = state.videos.filter((v) => prog[v.path]).sort((a, b) => prog[b.path].updatedAt - prog[a.path].updatedAt);
  const featured = inProgress[0] || state.videos[0];
  const img = featured.bannerUrl || featured.thumbUrl;

  hero.classList.remove('hidden');
  document.getElementById('hero-backdrop').style.backgroundImage = img ? `url("${img}")` : 'none';

  const posterWrap = document.getElementById('hero-poster-wrap');
  const posterEl = document.getElementById('hero-poster');
  if (img) {
    posterEl.src = img;
    posterWrap.classList.remove('hidden');
  } else {
    posterWrap.classList.add('hidden');
  }

  document.getElementById('hero-cat').textContent = t(`categories.${featured.category}`);
  document.getElementById('hero-year').textContent = featured.year || formatSize(featured.size);
  document.getElementById('hero-title').textContent = featured.title;

  const synEl = document.getElementById('hero-synopsis');
  synEl.textContent = featured.synopsis || '';
  synEl.classList.toggle('hidden', !featured.synopsis);

  const castEl = document.getElementById('hero-cast');
  castEl.textContent = featured.actors ? `${t('hero.castPrefix')} ${featured.actors}` : '';
  castEl.classList.toggle('hidden', !featured.actors);

  document.getElementById('hero-play-label').textContent = prog[featured.path] ? t('hero.resume') : t('hero.play');
  document.getElementById('hero-play-btn').onclick = () => openPlayer(featured);
  document.getElementById('hero-info-btn').onclick = () => openDetailModal(featured);

  const isFav = (state.config.favorites || []).includes(featured.path);
  const favBtn = document.getElementById('hero-fav-btn');
  favBtn.classList.toggle('is-fav', isFav);
  favBtn.onclick = async () => {
    state.config.favorites = await window.zantroAPI.toggleFavorite(featured.path);
    renderAll();
  };
}

function renderCinemaView() {
  renderWelcomeGreeting();
  renderHero();

  const catBar = document.getElementById('category-bar');
  const rowsWrap = document.getElementById('netflix-rows');
  const gridSec = document.getElementById('grid-section');
  const grid = document.getElementById('video-grid');
  const empty = document.getElementById('empty-state');

  rowsWrap.innerHTML = '';
  grid.innerHTML = '';

  if (!state.videos.length) {
    catBar.classList.add('hidden');
    gridSec.classList.add('hidden');
    empty.classList.remove('hidden');
    document.getElementById('empty-title').textContent = t('library.emptyTitle');
    return;
  }

  if (state.view === 'home' && !state.search) {
    catBar.classList.add('hidden');
    gridSec.classList.add('hidden');
    empty.classList.add('hidden');

    const prog = state.config.progress || {};
    const inProgress = state.videos.filter((v) => prog[v.path]).sort((a, b) => prog[b.path].updatedAt - prog[a.path].updatedAt);
    if (inProgress.length) rowsWrap.appendChild(buildRow(t('library.continueWatching'), inProgress));

    for (const cat of CATEGORIES) {
      const vids = state.videos.filter((v) => v.category === cat);
      if (vids.length) rowsWrap.appendChild(buildRow(t(`categories.${cat}`), vids));
    }
    return;
  }

  if (state.view === 'categories') {
    catBar.classList.remove('hidden');
    const usedCats = ['all', ...CATEGORIES.filter((c) => state.videos.some((v) => v.category === c))];
    catBar.innerHTML = '';
    usedCats.forEach((cat) => {
      const btn = document.createElement('button');
      btn.className = `cat-pill ${state.selectedCategory === cat ? 'active' : ''}`;
      btn.textContent = t(`categories.${cat}`);
      btn.onclick = () => { state.selectedCategory = cat; renderCinemaView(); };
      catBar.appendChild(btn);
    });
  } else {
    catBar.classList.add('hidden');
  }

  const filtered = getFilteredVideos();
  if (!filtered.length) {
    gridSec.classList.add('hidden');
    empty.classList.remove('hidden');
    document.getElementById('empty-title').textContent = t('library.noResults');
  } else {
    empty.classList.add('hidden');
    gridSec.classList.remove('hidden');
    filtered.forEach((v) => grid.appendChild(createVideoCard(v)));
  }
}

function buildRow(title, videos) {
  const sec = document.createElement('section');
  sec.className = 'library-section';
  sec.innerHTML = `<div class="section-header"><h2>${title}</h2></div><div class="video-row"></div>`;
  const row = sec.querySelector('.video-row');
  videos.forEach((v) => row.appendChild(createVideoCard(v)));
  return sec;
}

function renderManageView() {
  const fList = document.getElementById('folders-list');
  const folders = state.config.folders || [];
  fList.innerHTML = folders.length ? '' : `<div class="folder-item"><span>${t('manage.noFolders')}</span></div>`;
  folders.forEach((folder) => {
    const item = document.createElement('div');
    item.className = 'folder-item';
    item.innerHTML = `<span class="folder-path" title="${folder}">${folder}</span><button class="folder-remove">${t('manage.remove')}</button>`;
    item.querySelector('.folder-remove').onclick = async () => {
      const res = await window.zantroAPI.removeFolder(folder);
      state.config = res.config; state.videos = res.videos; renderAll();
    };
    fList.appendChild(item);
  });

  const fileList = document.getElementById('files-list');
  const files = state.config.files || [];
  fileList.innerHTML = files.length ? '' : `<div class="folder-item"><span>${t('manage.noFiles')}</span></div>`;
  files.forEach((file) => {
    const item = document.createElement('div');
    item.className = 'folder-item';
    item.innerHTML = `<span class="folder-path" title="${file}">${file}</span><button class="folder-remove">${t('manage.remove')}</button>`;
    item.querySelector('.folder-remove').onclick = async () => {
      const res = await window.zantroAPI.removeFile(file);
      state.config = res.config; state.videos = res.videos; renderAll();
    };
    fileList.appendChild(item);
  });

  document.getElementById('manage-movies-title').textContent = t('manage.moviesTitle', { count: state.videos.length });
  const mList = document.getElementById('manage-movies-list');
  mList.innerHTML = '';

  state.videos.forEach((vid) => {
    const row = document.createElement('div');
    row.className = 'manage-movie-row';
    const img = vid.bannerUrl || vid.thumbUrl || '';
    row.innerHTML = `
      <div class="manage-movie-left">
        ${img ? `<img class="manage-movie-thumb" src="${img}" />` : '<div class="manage-movie-thumb"></div>'}
        <div class="manage-movie-meta">
          <div class="manage-movie-title">${vid.title}</div>
          <div class="manage-movie-sub">${vid.year ? vid.year + ' · ' : ''}${vid.actors || vid.folder}</div>
        </div>
      </div>
      <div class="manage-movie-right">
        <select class="quick-cat-select">
          ${CATEGORIES.map((c) => `<option value="${c}" ${vid.category === c ? 'selected' : ''}>${t(`categories.${c}`)}</option>`).join('')}
        </select>
        <button class="small-btn edit-movie-btn">${t('manage.editBtn')}</button>
        <button class="folder-remove remove-movie-btn">${t('manage.remove')}</button>
      </div>
    `;

    row.querySelector('.quick-cat-select').onchange = async (e) => {
      const res = await window.zantroAPI.saveMetadata({
        videoPath: vid.path,
        data: {
          title: vid.title, year: vid.year, category: e.target.value,
          actors: vid.actors, synopsis: vid.synopsis, bannerPath: vid.bannerPath
        }
      });
      state.config = res.config; state.videos = res.videos; renderAll();
    };

    row.querySelector('.edit-movie-btn').onclick = () => openEditModal(vid);
    row.querySelector('.remove-movie-btn').onclick = async () => {
      const res = await window.zantroAPI.removeVideo(vid.path);
      state.config = res.config; state.videos = res.videos; renderAll();
    };

    mList.appendChild(row);
  });
}

function renderAll() {
  if (state.view === 'manage') renderManageView();
  else renderCinemaView();
}

// FICHE FILM & BIOGRAPHIE ACTEUR
const detailModal = document.getElementById('detail-modal');
const actorModal = document.getElementById('actor-modal');
document.getElementById('actor-close').onclick = () => actorModal.classList.add('hidden');
actorModal.onclick = (e) => { if (e.target === actorModal) actorModal.classList.add('hidden'); };

async function openActorBio(actor) {
  actorModal.classList.remove('hidden');
  document.getElementById('actor-modal-name').textContent = actor.name;
  document.getElementById('actor-modal-role').textContent = actor.bio || '';
  document.getElementById('actor-modal-bio').textContent = 'Chargement de la biographie...';

  const imgEl = document.getElementById('actor-modal-img');
  if (actor.photoUrl) {
    imgEl.src = actor.photoUrl;
    imgEl.classList.remove('hidden');
  } else {
    imgEl.classList.add('hidden');
  }

  const info = await window.zantroAPI.getActorBio(actor.name);
  if (info?.thumb && !actor.photoUrl) {
    imgEl.src = info.thumb;
    imgEl.classList.remove('hidden');
  }
  document.getElementById('actor-modal-bio').textContent = info?.extract || actor.bio || 'Aucune biographie disponible.';
}

function openDetailModal(vid) {
  detailModal.classList.remove('hidden');
  const banner = document.getElementById('detail-banner');
  const posterEl = document.getElementById('detail-poster');
  const img = vid.bannerUrl || vid.thumbUrl;
  banner.style.backgroundImage = img ? `url("${img}")` : 'none';

  if (img) {
    posterEl.src = img;
    posterEl.classList.remove('hidden');
  } else {
    posterEl.classList.add('hidden');
  }

  document.getElementById('detail-cat').textContent = t(`categories.${vid.category}`);
  document.getElementById('detail-year').textContent = vid.year || '';
  document.getElementById('detail-size').textContent = formatSize(vid.size);
  document.getElementById('detail-title').textContent = vid.title;
  document.getElementById('detail-synopsis').textContent = vid.synopsis || t('detail.noSynopsis');

  const castRow = document.getElementById('detail-cast-row');
  const castGrid = document.getElementById('detail-cast-grid');
  castGrid.innerHTML = '';

  const castList = (vid.cast && vid.cast.length)
    ? vid.cast
    : (vid.actors ? vid.actors.split(',').map((n) => ({ name: n.trim(), bio: '', photoUrl: '' })).filter((c) => c.name) : []);

  if (castList.length) {
    castRow.classList.remove('hidden');
    castList.forEach((actor) => {
      const initials = actor.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      const card = document.createElement('div');
      card.className = 'cast-card';
      card.innerHTML = `
        ${actor.photoUrl ? `<img class="cast-avatar" src="${actor.photoUrl}" loading="lazy" />` : `<div class="cast-avatar-fallback">${initials}</div>`}
        <div class="cast-name">${actor.name}</div>
        ${actor.bio ? `<div class="cast-bio-mini">${actor.bio}</div>` : ''}
      `;
      const av = card.querySelector('.cast-avatar');
      if (av) {
        av.onerror = () => {
          const fb = document.createElement('div');
          fb.className = 'cast-avatar-fallback';
          fb.textContent = initials;
          av.replaceWith(fb);
        };
      }
      card.onclick = () => openActorBio(actor);
      castGrid.appendChild(card);
    });
  } else {
    castRow.classList.add('hidden');
  }

  document.getElementById('detail-play-btn').onclick = () => {
    detailModal.classList.add('hidden');
    openPlayer(vid);
  };

  const isFav = (state.config.favorites || []).includes(vid.path);
  const favBtn = document.getElementById('detail-fav-btn');
  favBtn.classList.toggle('is-fav', isFav);
  favBtn.onclick = async () => {
    state.config.favorites = await window.zantroAPI.toggleFavorite(vid.path);
    favBtn.classList.toggle('is-fav', state.config.favorites.includes(vid.path));
    renderAll();
  };

  document.getElementById('detail-edit-btn').onclick = () => {
    detailModal.classList.add('hidden');
    openEditModal(vid);
  };
}

document.getElementById('detail-close').onclick = () => detailModal.classList.add('hidden');
detailModal.onclick = (e) => { if (e.target === detailModal) detailModal.classList.add('hidden'); };

const editModal = document.getElementById('edit-modal');
function openEditModal(vid) {
  state.editingVideo = vid;
  state.editBannerPath = vid.bannerPath || '';
  state.editBannerPreviewUrl = vid.bannerPath ? vid.bannerUrl : '';

  document.getElementById('edit-title').value = vid.title;
  document.getElementById('edit-year').value = vid.year || '';
  document.getElementById('edit-category').value = vid.category || 'other';
  document.getElementById('edit-actors').value = vid.actors || '';
  document.getElementById('edit-synopsis').value = vid.synopsis || '';

  updateEditBannerPreview();
  editModal.classList.remove('hidden');
}

function updateEditBannerPreview() {
  const prev = document.getElementById('edit-banner-preview');
  if (state.editBannerPreviewUrl) {
    prev.style.backgroundImage = `url("${state.editBannerPreviewUrl}")`;
    prev.classList.remove('hidden');
  } else {
    prev.classList.add('hidden');
  }
}

document.getElementById('edit-pick-banner').onclick = async () => {
  const picked = await window.zantroAPI.pickBanner();
  if (picked) {
    state.editBannerPath = picked.path;
    state.editBannerPreviewUrl = picked.url;
    updateEditBannerPreview();
  }
};

document.getElementById('edit-reset-banner').onclick = () => {
  state.editBannerPath = '';
  state.editBannerPreviewUrl = '';
  updateEditBannerPreview();
};

document.getElementById('edit-form').onsubmit = async (e) => {
  e.preventDefault();
  if (!state.editingVideo) return;
  const res = await window.zantroAPI.saveMetadata({
    videoPath: state.editingVideo.path,
    data: {
      title: document.getElementById('edit-title').value.trim() || state.editingVideo.title,
      year: document.getElementById('edit-year').value.trim(),
      category: document.getElementById('edit-category').value,
      actors: document.getElementById('edit-actors').value.trim(),
      synopsis: document.getElementById('edit-synopsis').value.trim(),
      bannerPath: state.editBannerPath
    }
  });
  state.config = res.config;
  state.videos = res.videos;
  editModal.classList.add('hidden');
  renderAll();
};

document.getElementById('edit-close').onclick = () => editModal.classList.add('hidden');
editModal.onclick = (e) => { if (e.target === editModal) editModal.classList.add('hidden'); };

// LECTEUR STREAMING
const playerModal = document.getElementById('player-modal');
const videoEl = document.getElementById('video-element');
const playerUI = document.getElementById('player-ui');

function getTotalDuration() {
  return state.isStream ? (state.streamDuration || videoEl.duration || 0) : (videoEl.duration || 0);
}

function getRealTime() {
  return state.isStream ? (state.streamOffset + (videoEl.currentTime || 0)) : (videoEl.currentTime || 0);
}

function seekTo(targetSec) {
  const total = getTotalDuration();
  const clamped = Math.max(0, Math.min(total > 1 ? total - 1 : 0, targetSec));
  if (!state.isStream) { videoEl.currentTime = clamped; return; }

  clearTimeout(state.seekTimer);
  state.seekTimer = setTimeout(() => {
    state.streamOffset = clamped;
    document.getElementById('player-loading').classList.remove('hidden');
    videoEl.src = `${state.streamBaseUrl}&start=${Math.floor(clamped)}`;
    videoEl.playbackRate = state.speeds[state.speedIndex];
    videoEl.play().catch(() => {});
  }, 150);
}

function showIndicator(text) {
  const ind = document.getElementById('player-center-indicator');
  ind.textContent = text;
  ind.classList.remove('hidden');
  clearTimeout(ind._t);
  ind._t = setTimeout(() => ind.classList.add('hidden'), 650);
}

function resetIdleTimer() {
  playerUI.classList.remove('idle');
  playerModal.classList.remove('hide-cursor');
  clearTimeout(state.idleTimer);
  if (!videoEl.paused && !videoEl.ended) {
    state.idleTimer = setTimeout(() => {
      if (!videoEl.paused) {
        playerUI.classList.add('idle');
        playerModal.classList.add('hide-cursor');
      }
    }, 1800);
  }
}

async function openPlayer(videoObj) {
  const list = state.videos;
  const idx = list.findIndex((v) => v.path === videoObj.path);
  state.currentVideoIndex = idx >= 0 ? idx : 0;

  playerModal.classList.remove('hidden');
  document.getElementById('player-title').textContent = videoObj.title;
  document.getElementById('player-subtitle').textContent = videoObj.actors || t(`categories.${videoObj.category}`);

  const loadingEl = document.getElementById('player-loading');
  document.getElementById('player-loading-text').textContent = 'Chargement...';
  loadingEl.classList.remove('hidden');

  const prepared = await window.zantroAPI.preparePlay(videoObj.path);
  if (playerModal.classList.contains('hidden')) return;

  const saved = state.config.progress[videoObj.path];
  const totalDur = prepared.duration || saved?.duration || 0;
  const resumeAt = (saved && totalDur && saved.currentTime < totalDur - 5) ? saved.currentTime : 0;

  state.isStream = !!prepared.isStream;
  state.streamDuration = totalDur;

  if (state.isStream) {
    state.streamBaseUrl = prepared.fileUrl;
    state.streamOffset = resumeAt;
    videoEl.src = `${prepared.fileUrl}&start=${Math.floor(resumeAt)}`;
    videoEl.playbackRate = state.speeds[state.speedIndex];
    videoEl.oncanplay = () => loadingEl.classList.add('hidden');
    videoEl.play().then(() => { updatePlayIcon(); resetIdleTimer(); }).catch(() => {});
  } else {
    state.streamBaseUrl = '';
    state.streamOffset = 0;
    videoEl.src = prepared.fileUrl;
    videoEl.playbackRate = state.speeds[state.speedIndex];
    videoEl.onloadedmetadata = () => {
      loadingEl.classList.add('hidden');
      if (resumeAt > 0) videoEl.currentTime = resumeAt;
      videoEl.play().then(() => { updatePlayIcon(); resetIdleTimer(); }).catch(() => {});
    };
  }
  resetIdleTimer();
}

function closePlayer() {
  clearTimeout(state.idleTimer);
  clearTimeout(state.seekTimer);
  persistCurrentProgress(true);
  window.zantroAPI.cancelPrepare();
  document.getElementById('player-loading').classList.add('hidden');
  videoEl.pause();
  videoEl.removeAttribute('src');
  videoEl.load();
  state.isStream = false;
  state.streamOffset = 0;
  if (document.fullscreenElement) document.exitFullscreen();
  playerModal.classList.add('hidden');
  renderAll();
}

async function persistCurrentProgress(force = false) {
  const current = state.videos[state.currentVideoIndex];
  const dur = getTotalDuration();
  if (!current || !dur) return;
  const now = Date.now();
  if (!force && now - state.lastProgressSave < 4000) return;
  state.lastProgressSave = now;
  state.config.progress = await window.zantroAPI.saveProgress({
    videoPath: current.path, currentTime: getRealTime(), duration: dur
  });
}

function updatePlayIcon() {
  document.getElementById('ctrl-play-icon').innerHTML = videoEl.paused
    ? '<polygon points="6 4 20 12 6 20 6 4"></polygon>'
    : '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
}

function togglePlay() {
  if (videoEl.paused) { videoEl.play(); showIndicator('▶'); }
  else { videoEl.pause(); persistCurrentProgress(true); showIndicator('⏸'); }
  updatePlayIcon();
  resetIdleTimer();
}

function playNeighbor(delta) {
  if (!state.videos.length) return;
  const nextIdx = (state.currentVideoIndex + delta + state.videos.length) % state.videos.length;
  persistCurrentProgress(true);
  openPlayer(state.videos[nextIdx]);
}

document.getElementById('player-back').onclick = closePlayer;
document.getElementById('ctrl-play').onclick = togglePlay;
videoEl.onclick = togglePlay;
videoEl.ondblclick = () => document.getElementById('ctrl-fullscreen').click();
document.getElementById('ctrl-prev').onclick = () => playNeighbor(-1);
document.getElementById('ctrl-next').onclick = () => playNeighbor(1);

playerModal.addEventListener('mousemove', resetIdleTimer);
playerModal.addEventListener('mouseleave', () => {
  if (!videoEl.paused) { clearTimeout(state.idleTimer); playerUI.classList.add('idle'); }
});
document.addEventListener('fullscreenchange', resetIdleTimer);
videoEl.addEventListener('play', () => { updatePlayIcon(); resetIdleTimer(); });
videoEl.addEventListener('playing', () => {
  document.getElementById('player-loading').classList.add('hidden');
  updatePlayIcon();
  resetIdleTimer();
});
videoEl.addEventListener('pause', () => {
  updatePlayIcon();
  clearTimeout(state.idleTimer);
  playerUI.classList.remove('idle');
  playerModal.classList.remove('hide-cursor');
});

videoEl.addEventListener('timeupdate', () => {
  const dur = getTotalDuration();
  if (!dur) return;
  const cur = getRealTime();
  const pct = Math.min(100, (cur / dur) * 100);
  document.getElementById('progress-bar-fill').style.width = `${pct}%`;
  document.getElementById('progress-thumb').style.left = `${pct}%`;
  document.getElementById('time-current').textContent = formatTime(cur);
  document.getElementById('time-total').textContent = formatTime(dur);
  persistCurrentProgress(false);
});
videoEl.addEventListener('ended', () => { persistCurrentProgress(true); playNeighbor(1); });

const progressContainer = document.getElementById('progress-container');
progressContainer.onclick = (e) => {
  const dur = getTotalDuration();
  if (!dur) return;
  const rect = progressContainer.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  seekTo(ratio * dur);
};

document.getElementById('ctrl-volume').oninput = (e) => {
  videoEl.volume = parseFloat(e.target.value);
  videoEl.muted = videoEl.volume === 0;
};
document.getElementById('ctrl-mute').onclick = () => {
  videoEl.muted = !videoEl.muted;
  document.getElementById('ctrl-volume').value = videoEl.muted ? 0 : videoEl.volume;
};
document.getElementById('ctrl-speed').onclick = (e) => {
  state.speedIndex = (state.speedIndex + 1) % state.speeds.length;
  const sp = state.speeds[state.speedIndex];
  videoEl.playbackRate = sp;
  e.target.textContent = `${sp}x`;
  showIndicator(`${sp}x`);
};
document.getElementById('ctrl-pip').onclick = async () => {
  if (document.pictureInPictureElement) await document.exitPictureInPicture();
  else if (document.pictureInPictureEnabled) await videoEl.requestPictureInPicture();
};
document.getElementById('ctrl-fullscreen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else playerModal.requestFullscreen();
};

window.addEventListener('keydown', (e) => {
  if (playerModal.classList.contains('hidden')) return;
  if (e.code === 'Space' || e.key.toLowerCase() === 'k') { e.preventDefault(); togglePlay(); }
  else if (e.key.toLowerCase() === 'f') document.getElementById('ctrl-fullscreen').click();
  else if (e.key.toLowerCase() === 'm') document.getElementById('ctrl-mute').click();
  else if (e.code === 'ArrowRight') { seekTo(getRealTime() + 10); showIndicator('+10s'); }
  else if (e.code === 'ArrowLeft') { seekTo(getRealTime() - 10); showIndicator('-10s'); }
  else if (e.code === 'Escape' && !document.fullscreenElement) closePlayer();
});

// NAVIGATION, DROP & PARAMÈTRES
document.querySelectorAll('.nav-tab').forEach((tab) => { tab.onclick = () => setActiveView(tab.dataset.view); });
document.getElementById('brand-logo').onclick = () => setActiveView('home');
document.getElementById('empty-go-manage').onclick = () => setActiveView('manage');
document.getElementById('search-input').oninput = (e) => {
  state.search = e.target.value;
  if (state.view === 'manage') setActiveView('home');
  else renderAll();
};

async function handlePickFolder() {
  const res = await window.zantroAPI.pickFolder();
  if (res) { state.config = res.config; state.videos = res.videos; renderAll(); generateMissingThumbnails(); }
}
async function handlePickFiles() {
  const res = await window.zantroAPI.pickFiles();
  if (res) { state.config = res.config; state.videos = res.videos; renderAll(); generateMissingThumbnails(); }
}

document.getElementById('manage-add-folder').onclick = handlePickFolder;
document.getElementById('manage-add-file').onclick = handlePickFiles;

const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropOverlay.classList.remove('hidden'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { dragDepth--; if (dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.add('hidden'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; dropOverlay.classList.add('hidden');
  const paths = Array.from(e.dataTransfer.files).map((f) => window.zantroAPI.getPathForFile(f)).filter(Boolean);
  if (paths.length) {
    const res = await window.zantroAPI.addDropped(paths);
    state.config = res.config; state.videos = res.videos; renderAll(); generateMissingThumbnails();
  }
});

const onboardingModal = document.getElementById('onboarding-modal');
const onboardingInput = document.getElementById('onboarding-input');
document.getElementById('onboarding-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = onboardingInput.value.trim();
  if (!name) return;
  state.config.username = await window.zantroAPI.setUsername(name);
  onboardingModal.classList.add('hidden');
  renderWelcomeGreeting();
};

const settingsModal = document.getElementById('settings-modal');
document.getElementById('btn-settings').onclick = () => {
  document.getElementById('settings-username-input').value = state.config.username || '';
  settingsModal.classList.remove('hidden');
};
document.getElementById('btn-close-settings').onclick = () => settingsModal.classList.add('hidden');
settingsModal.onclick = (e) => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); };

document.getElementById('settings-username-save').onclick = async () => {
  const val = document.getElementById('settings-username-input').value.trim();
  if (!val) return;
  state.config.username = await window.zantroAPI.setUsername(val);
  renderWelcomeGreeting();
};

document.getElementById('btn-theme-quick').onclick = async () => {
  const order = ['dark', 'light', 'auto'];
  const next = order[(order.indexOf(state.config.settings.theme) + 1) % order.length];
  state.config.settings = await window.zantroAPI.saveSettings({ theme: next });
  applyTheme();
};
document.querySelectorAll('.theme-card').forEach((card) => {
  card.onclick = async () => {
    state.config.settings = await window.zantroAPI.saveSettings({ theme: card.dataset.themeChoice });
    applyTheme();
  };
});
document.querySelectorAll('.lang-pill').forEach((btn) => {
  btn.onclick = async () => {
    state.config.settings = await window.zantroAPI.saveSettings({ language: btn.dataset.langChoice });
    applyTranslations(); renderAll();
  };
});
document.getElementById('toggle-intro-sound').onchange = async (e) => {
  state.config.settings = await window.zantroAPI.saveSettings({ introSound: e.target.checked });
};
document.getElementById('btn-replay-intro').onclick = () => { settingsModal.classList.add('hidden'); runIntroAnimation(); };
document.getElementById('btn-clear-progress').onclick = async () => {
  state.config.progress = await window.zantroAPI.clearProgress();
  renderAll();
};

window.zantroAPI.onVideosUpdated((data) => {
  state.config = data.config;
  state.videos = data.videos;
  renderAll();
});

// INITIALISATION
(async function bootstrap() {
  const data = await window.zantroAPI.init();
  state.config = data.config;
  state.videos = data.videos;
  state.locales = data.locales;

  document.getElementById('toggle-intro-sound').checked = !!state.config.settings.introSound;
  applyTheme();
  applyTranslations();
  renderAll();

  runIntroAnimation(() => {
    if (!state.config.username) {
      onboardingModal.classList.remove('hidden');
      setTimeout(() => onboardingInput.focus(), 100);
    }
  });

  generateMissingThumbnails();
})();