(() => {
  const scrollToTarget = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  document.querySelectorAll('[data-scroll-target]').forEach((el) => {
    const target = el.dataset.scrollTarget;
    if (!target) return;

    if (el.classList.contains('scroll-hero')) {
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('a, button, input, textarea, select')) return;
        scrollToTarget(target);
      });
      return;
    }

    el.addEventListener('click', () => scrollToTarget(target));
  });

  const intro = document.getElementById('landing-intro');
  const introEnter = document.getElementById('intro-enter');
  if (intro && introEnter) {
    const state = { tx: 0, ty: 0, x: 0, y: 0 };
    const tick = () => {
      state.x += (state.tx - state.x) * 0.08;
      state.y += (state.ty - state.y) * 0.08;
      document.documentElement.style.setProperty('--intro-mx', state.x.toFixed(3));
      document.documentElement.style.setProperty('--intro-my', state.y.toFixed(3));
      requestAnimationFrame(tick);
    };
    tick();

    intro.addEventListener('pointermove', (ev) => {
      const rect = intro.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width;
      const py = (ev.clientY - rect.top) / rect.height;
      state.tx = (px - 0.5) * 2;
      state.ty = (py - 0.5) * 2;
    });

    intro.addEventListener('pointerleave', () => {
      state.tx = 0;
      state.ty = 0;
    });

    introEnter.addEventListener('click', () => {
      if (document.body.classList.contains('intro-pushing')) return;
      window.scrollTo(0, 0);
      intro.style.pointerEvents = 'none';
      document.body.classList.add('intro-pushing');
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) {
        intro.remove();
        window.scrollTo(0, 0);
        document.body.classList.remove('has-landing-intro');
        document.body.classList.remove('intro-pushing');
        return;
      }

      let settled = false;
      const finalize = () => {
        if (settled) return;
        settled = true;
        intro.remove();
        window.scrollTo(0, 0);
        document.body.classList.remove('has-landing-intro');
        document.body.classList.remove('intro-pushing');
      };

      intro.addEventListener('animationend', (ev) => {
        if (ev.animationName === 'introPushUp') finalize();
      }, { once: true });

      // Fallback guard in case animationend is skipped by browser.
      setTimeout(finalize, 1150);
    });
  }

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

  document.querySelectorAll('.calendar-class-block:not(.trainer-chip), .month-class-chip:not(.trainer-chip)').forEach((btn) => {
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

  const trainerModal = document.getElementById('trainer-class-modal');
  const trainerTitle = document.getElementById('trainer-modal-title');
  const trainerMeta = document.getElementById('trainer-modal-meta');
  const trainerStatus = document.getElementById('trainer-modal-status');
  const trainerCancelForm = document.getElementById('trainer-cancel-form');
  const trainerCancelBtn = document.getElementById('trainer-cancel-btn');

  document.querySelectorAll('.trainer-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!trainerModal || !trainerTitle || !trainerMeta || !trainerStatus || !trainerCancelForm || !trainerCancelBtn) return;
      const id = btn.dataset.trainerOccurrenceId || '';
      const status = btn.dataset.trainerStatus || 'SCHEDULED';
      const canCancel = btn.dataset.trainerCancelable === '1';
      trainerTitle.textContent = btn.dataset.trainerClass || 'Clase';
      trainerMeta.textContent = `${btn.dataset.trainerTime || ''} · Reservas: ${btn.dataset.trainerBookings || '0'}`;
      trainerStatus.textContent = `Estado: ${status === 'CANCELLED' ? 'CANCELADA' : 'PROGRAMADA'}`;
      trainerCancelForm.action = `/trainer/classes/${id}/cancel`;
      trainerCancelBtn.disabled = !canCancel;
      trainerCancelBtn.textContent = canCancel ? 'Cancelar clase' : 'No cancelable';
      if (typeof trainerModal.showModal === 'function') trainerModal.showModal();
    });
  });

  document.querySelectorAll('[data-close-trainer-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (trainerModal && typeof trainerModal.close === 'function') trainerModal.close();
    });
  });
})();
