(() => {
  const scrollToTarget = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const simBanner = document.querySelector('.sim-banner');
    const siteHeader = document.querySelector('.site-header');
    const isMobile = window.innerWidth <= 760;
    const isLandingTarget = id === 'landing-main-hero' || id === 'landing-overview';
    const extraOffset = (isMobile ? 28 : 0) + (isLandingTarget ? 18 : 0);
    const offset =
      (simBanner ? simBanner.getBoundingClientRect().height : 0) +
      (siteHeader ? siteHeader.getBoundingClientRect().height : 0) +
      12 +
      extraOffset;
    const top = window.scrollY + el.getBoundingClientRect().top - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
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
  if (intro) {
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

    const startIntroTransition = () => {
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
    };

    intro.addEventListener('click', (ev) => {
      if (ev.target.closest('a, input, textarea, select')) return;
      startIntroTransition();
    });

    if (introEnter) {
      introEnter.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        startIntroTransition();
      });
    }
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

  const seatForm = document.getElementById('seat-selection-form');
  if (seatForm) {
    const seatInputs = Array.from(seatForm.querySelectorAll('input[name="seatCodes"]'));
    const countLabel = document.getElementById('seat-selection-count');
    const summaryLabel = document.getElementById('seat-selection-summary');
    const seatViewport = seatForm.querySelector('[data-seat-viewport]');
    const seatCanvas = seatForm.querySelector('[data-seat-canvas]');

    const updateSeatSummary = () => {
      const selected = seatInputs.filter((input) => input.checked);
      const labels = selected.map((input) => input.value);
      seatInputs.forEach((input) => {
        const option = input.closest('[data-seat-option]');
        if (!option || option.classList.contains('is-occupied') || option.classList.contains('is-disabled')) return;
        option.classList.toggle('is-selected', input.checked);
        option.classList.toggle('is-available', !input.checked);
      });
      if (countLabel) {
        countLabel.textContent = `${selected.length} de 2 lugares elegidos`;
      }
      if (summaryLabel) {
        summaryLabel.textContent = labels.length ? `Lugares elegidos: ${labels.join(', ')}` : 'Selecciona uno o dos lugares para continuar.';
      }
    };

    seatInputs.forEach((input) => {
      input.addEventListener('change', () => {
        const selected = seatInputs.filter((item) => item.checked);
        if (selected.length > 2) {
          input.checked = false;
        }
        updateSeatSummary();
      });
    });

    if (seatViewport && seatCanvas) {
      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
      const isSeatTarget = (target) => target instanceof Element && Boolean(target.closest('[data-seat-option]'));
      const pointers = new Map();
      let scale = 1;
      let minScale = 1;
      let maxScale = 2.4;
      let x = 0;
      let y = 0;
      let panPointerId = null;
      let lastPoint = null;
      let pinchDistance = 0;

      const clampPosition = () => {
        const scaledWidth = seatCanvas.offsetWidth * scale;
        const scaledHeight = seatCanvas.offsetHeight * scale;
        const minX = Math.min(0, seatViewport.clientWidth - scaledWidth);
        const minY = Math.min(0, seatViewport.clientHeight - scaledHeight);
        const maxX = scaledWidth < seatViewport.clientWidth ? (seatViewport.clientWidth - scaledWidth) / 2 : 0;
        const maxY = scaledHeight < seatViewport.clientHeight ? (seatViewport.clientHeight - scaledHeight) / 2 : 0;
        x = clamp(x, minX, maxX);
        y = clamp(y, minY, maxY);
      };

      const applyTransform = () => {
        clampPosition();
        seatCanvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      };

      const fitCanvas = () => {
        const widthScale = seatViewport.clientWidth / seatCanvas.offsetWidth;
        const heightScale = seatViewport.clientHeight / seatCanvas.offsetHeight;
        minScale = Math.min(widthScale, heightScale, 1);
        maxScale = Math.max(minScale * 2.8, 1.8);
        scale = minScale;
        x = (seatViewport.clientWidth - seatCanvas.offsetWidth * scale) / 2;
        y = (seatViewport.clientHeight - seatCanvas.offsetHeight * scale) / 2;
        applyTransform();
      };

      const zoomAt = (nextScale, clientX, clientY) => {
        const boundedScale = clamp(nextScale, minScale, maxScale);
        if (boundedScale === scale) return;
        const rect = seatViewport.getBoundingClientRect();
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        const worldX = (localX - x) / scale;
        const worldY = (localY - y) / scale;
        scale = boundedScale;
        x = localX - worldX * scale;
        y = localY - worldY * scale;
        applyTransform();
      };

      const getPinchMetrics = () => {
        const values = Array.from(pointers.values());
        if (values.length < 2) return null;
        const [first, second] = values;
        return {
          distance: Math.hypot(second.x - first.x, second.y - first.y),
          centerX: (first.x + second.x) / 2,
          centerY: (first.y + second.y) / 2,
        };
      };

      seatViewport.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          const factor = event.deltaY < 0 ? 1.12 : 0.9;
          zoomAt(scale * factor, event.clientX, event.clientY);
        },
        { passive: false },
      );

      seatViewport.addEventListener('pointerdown', (event) => {
        if (isSeatTarget(event.target)) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        seatViewport.setPointerCapture?.(event.pointerId);
        if (pointers.size === 2) {
          const metrics = getPinchMetrics();
          pinchDistance = metrics ? metrics.distance : 0;
          panPointerId = null;
          lastPoint = null;
          seatViewport.classList.remove('is-panning');
          return;
        }

        panPointerId = event.pointerId;
        lastPoint = { x: event.clientX, y: event.clientY };
        seatViewport.classList.add('is-panning');
      });

      seatViewport.addEventListener('pointermove', (event) => {
        if (!pointers.has(event.pointerId)) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (pointers.size === 2) {
          const metrics = getPinchMetrics();
          if (!metrics) return;
          if (!pinchDistance) {
            pinchDistance = metrics.distance;
            return;
          }
          if (metrics.distance > 0) {
            zoomAt(scale * (metrics.distance / pinchDistance), metrics.centerX, metrics.centerY);
            pinchDistance = metrics.distance;
          }
          return;
        }

        if (panPointerId !== event.pointerId || !lastPoint) return;
        x += event.clientX - lastPoint.x;
        y += event.clientY - lastPoint.y;
        lastPoint = { x: event.clientX, y: event.clientY };
        applyTransform();
      });

      const stopPointer = (event) => {
        pointers.delete(event.pointerId);
        if (pointers.size < 2) pinchDistance = 0;
        if (panPointerId === event.pointerId) {
          panPointerId = null;
          lastPoint = null;
          seatViewport.classList.remove('is-panning');
        }
      };

      seatViewport.addEventListener('pointerup', stopPointer);
      seatViewport.addEventListener('pointercancel', stopPointer);
      seatViewport.addEventListener('lostpointercapture', stopPointer);
      window.addEventListener('resize', fitCanvas);
      fitCanvas();
    }

    updateSeatSummary();
  }

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
