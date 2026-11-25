const root = document.documentElement;
document.querySelector('.theme').addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('cb-theme', root.dataset.theme);
});

const rows = [...document.querySelectorAll('#stores tbody tr')];
const buttons = [...document.querySelectorAll('.filters button')];
buttons.forEach((button) =>
  button.addEventListener('click', () => {
    buttons.forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
    const tag = button.dataset.tag;
    rows.forEach((row) => {
      row.hidden = tag !== 'all' && row.dataset.ending !== tag;
    });
  })
);

const tip = document.querySelector('.tip');
const show = (target) => {
  tip.textContent = '';
  const title = document.createElement('strong');
  title.textContent = target.dataset.tip;
  tip.append(title);
  if (target.dataset.list) {
    const list = document.createElement('span');
    list.textContent = target.dataset.list;
    tip.append(list);
  }
  tip.hidden = false;
  const box = target.getBoundingClientRect();
  const own = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left + box.width / 2 - own.width / 2), innerWidth - own.width - 8);
  const above = box.top - own.height - 8;
  tip.style.left = `${left + scrollX}px`;
  tip.style.top = `${(above < 8 ? box.bottom + 8 : above) + scrollY}px`;
};
const hide = () => {
  tip.hidden = true;
};
document.addEventListener('pointerover', (event) => {
  const target = event.target.closest('[data-tip]');
  if (target) show(target);
  else hide();
});
document.addEventListener('focusin', (event) => {
  const target = event.target.closest('[data-tip]');
  if (target) show(target);
});
document.addEventListener('focusout', hide);
addEventListener('scroll', hide, { passive: true });

const canHover = matchMedia('(hover:hover) and (pointer:fine)').matches;
const loader = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.src = entry.target.dataset.src;
      entry.target.preload = 'metadata';
      loader.unobserve(entry.target);
    }
  },
  { rootMargin: '600px 0px' }
);
document.querySelectorAll('.ev-media').forEach((media) => {
  const video = media.querySelector('video');
  const bar = media.querySelector('.ev-bar');
  loader.observe(video);
  const playing = () => media.classList.contains('playing');
  video.addEventListener('timeupdate', () => {
    if (video.duration) bar.style.transform = `scaleX(${video.currentTime / video.duration})`;
  });
  video.addEventListener('ended', () => {
    if (!playing()) {
      video.currentTime = 0;
      video.play().catch(() => {});
    }
  });
  if (canHover) {
    media.addEventListener('pointerenter', () => {
      if (playing()) return;
      media.classList.add('preview');
      video.play().catch(() => {});
    });
    media.addEventListener('pointerleave', () => {
      if (playing()) return;
      media.classList.remove('preview');
      video.pause();
    });
  }
  media.querySelector('.ev-play').addEventListener('click', () => {
    media.classList.remove('preview');
    media.classList.add('playing');
    video.controls = true;
    video.muted = false;
    video.currentTime = 0;
    video.play().catch(() => {});
  });
});

const copy = document.querySelector('.copy');
const status = document.querySelector('[role=status]');
let reset;
copy.addEventListener('click', async () => {
  const text = document.querySelector('.prompt-src').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  copy.dataset.state = 'done';
  status.textContent = 'Prompt copied to clipboard';
  clearTimeout(reset);
  reset = setTimeout(() => {
    copy.dataset.state = 'idle';
    status.textContent = '';
  }, 2200);
});

fetch('https://api.github.com/repos/anchorbrowser/commerce-bench')
  .then((response) => (response.ok ? response.json() : null))
  .then((data) => {
    if (!data || !(data.stargazers_count > 0)) return;
    const count = document.querySelector('.star-n');
    count.textContent = data.stargazers_count.toLocaleString('en');
    count.hidden = false;
  })
  .catch(() => {});
