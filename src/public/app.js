(() => {
  const revealEls = document.querySelectorAll('.reveal');
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) entry.target.classList.add('show');
      }
    },
    { threshold: 0.15 }
  );
  revealEls.forEach((el) => io.observe(el));

  const parallaxEls = document.querySelectorAll('.parallax');
  const storyRoot = document.querySelector('.story-root');

  const updateVisualStory = () => {
    const y = window.scrollY;
    parallaxEls.forEach((el, i) => {
      el.style.setProperty('--parallax', `${(i + 1) * y * 0.05}px`);
    });

    if (!storyRoot) return;

    const rect = storyRoot.getBoundingClientRect();
    const start = window.innerHeight * 0.08;
    const total = Math.max(storyRoot.offsetHeight - window.innerHeight * 0.8, 1);
    const progressed = Math.min(Math.max((start - rect.top) / total, 0), 1);

    // Night mode: by end of scroll this reaches full black.
    document.documentElement.style.setProperty('--night-progress', progressed.toFixed(3));

    // Dim/flicker lights progressively while descending.
    const flicker = (Math.sin(Date.now() * 0.004) + 1) / 2;
    const dim = Math.min(1, progressed * 0.9 + flicker * 0.08);
    document.documentElement.style.setProperty('--glow-dim', dim.toFixed(3));
  };

  updateVisualStory();
  window.addEventListener('scroll', updateVisualStory, { passive: true });
  window.addEventListener('resize', updateVisualStory);

  setInterval(() => {
    if (!storyRoot) return;
    const progressed = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--night-progress')) || 0;
    const flicker = (Math.sin(Date.now() * 0.006) + 1) / 2;
    const dim = Math.min(1, progressed * 0.9 + flicker * 0.08);
    document.documentElement.style.setProperty('--glow-dim', dim.toFixed(3));
  }, 160);

  const modal = document.getElementById('booking-modal');
  const title = document.getElementById('booking-title');
  const meta = document.getElementById('booking-meta');
  const seats = document.getElementById('booking-seats');
  const occInput = document.getElementById('booking-occurrence-id');

  document.querySelectorAll('.calendar-class-block').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!modal || !title || !meta || !seats || !occInput) return;
      occInput.value = btn.dataset.occurrenceId || '';
      title.textContent = btn.dataset.className || 'Reservar clase';
      meta.textContent = `${btn.dataset.start || ''} · ${btn.dataset.trainer || ''} · ${btn.dataset.location || ''}`;
      seats.textContent = `Cupos disponibles: ${btn.dataset.cupos || '0'}`;
      if (typeof modal.showModal === 'function') modal.showModal();
    });
  });

  document.querySelectorAll('[data-close-booking]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (modal && typeof modal.close === 'function') modal.close();
    });
  });
})();
