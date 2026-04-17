(() => {
  const simBanner = document.querySelector('.sim-banner');
  const siteHeader = document.querySelector('.site-header');

  const syncFixedChromeOffset = () => {
    const simBannerHeight = simBanner ? simBanner.getBoundingClientRect().height : 0;
    const siteHeaderHeight = siteHeader ? siteHeader.getBoundingClientRect().height : 0;
    const totalOffset = simBannerHeight + siteHeaderHeight;
    document.documentElement.style.setProperty('--sim-banner-height', `${simBannerHeight}px`);
    document.documentElement.style.setProperty('--site-header-height', `${siteHeaderHeight}px`);
    document.documentElement.style.setProperty('--fixed-chrome-offset', `${totalOffset}px`);
  };

  const scrollToTarget = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    syncFixedChromeOffset();
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
  const introDiscover = document.getElementById('intro-discover');
  const introReserve = document.getElementById('intro-reserve');
  if (intro) {
    const introPreviewMode = new URLSearchParams(window.location.search).get('previewIntro') === '1';
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
        syncFixedChromeOffset();
      };

      intro.addEventListener('animationend', (ev) => {
        if (ev.animationName === 'introPushUp') finalize();
      }, { once: true });

      // Fallback guard in case animationend is skipped by browser.
      setTimeout(finalize, 1150);
    };

    if (introDiscover) {
      introDiscover.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        startIntroTransition();
      });
    }

    if (introReserve) {
      introReserve.addEventListener('click', (ev) => {
        ev.preventDefault();
        window.location.assign('/classes');
      });
    }

    if (introPreviewMode) {
      requestAnimationFrame(() => startIntroTransition());
    }
  }

  syncFixedChromeOffset();
  window.addEventListener('resize', syncFixedChromeOffset);

  const revealEls = document.querySelectorAll('.reveal');
  const previewRevealMode = new URLSearchParams(window.location.search).get('previewIntro') === '1';
  if (previewRevealMode) {
    revealEls.forEach((el) => el.classList.add('show'));
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) entry.target.classList.add('show');
      }
    },
    { threshold: 0.15 }
  );
  if (!previewRevealMode) {
    revealEls.forEach((el) => io.observe(el));
  }

  const parallaxEls = document.querySelectorAll('.parallax');
  const storyRoot = document.querySelector('.story-root');

  document.querySelectorAll('[data-card-carousel]').forEach((carousel) => {
    const viewport = carousel.querySelector('[data-carousel-viewport]');
    const track = carousel.querySelector('.landing-carousel-track');
    const prevButton = carousel.querySelector('[data-carousel-prev]');
    const nextButton = carousel.querySelector('[data-carousel-next]');
    if (!viewport || !track || !prevButton || !nextButton) return;
    let isDragging = false;
    let pointerId = null;
    let startX = 0;
    let startScrollLeft = 0;

    const getStep = () => {
      const firstCard = track.firstElementChild;
      const styles = window.getComputedStyle(track);
      const gap = Number.parseFloat(styles.columnGap || styles.gap || '0') || 0;
      return firstCard ? firstCard.getBoundingClientRect().width + gap : viewport.clientWidth * 0.9;
    };

    const updateButtons = () => {
      const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth - 2);
      prevButton.disabled = viewport.scrollLeft <= 2;
      nextButton.disabled = viewport.scrollLeft >= maxScroll;
    };

    const scrollByCard = (direction) => {
      viewport.scrollBy({ left: getStep() * direction, behavior: 'smooth' });
    };

    prevButton.addEventListener('click', () => scrollByCard(-1));
    nextButton.addEventListener('click', () => scrollByCard(1));
    viewport.addEventListener('scroll', updateButtons, { passive: true });
    window.addEventListener('resize', updateButtons);

    viewport.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      isDragging = true;
      pointerId = event.pointerId;
      startX = event.clientX;
      startScrollLeft = viewport.scrollLeft;
      viewport.classList.add('is-dragging');
      viewport.setPointerCapture?.(event.pointerId);
    });

    viewport.addEventListener('pointermove', (event) => {
      if (!isDragging || pointerId !== event.pointerId) return;
      const delta = event.clientX - startX;
      viewport.scrollLeft = startScrollLeft - delta;
    });

    const stopDrag = (event) => {
      if (pointerId !== null && event.pointerId !== pointerId) return;
      isDragging = false;
      pointerId = null;
      viewport.classList.remove('is-dragging');
      updateButtons();
    };

    viewport.addEventListener('pointerup', stopDrag);
    viewport.addEventListener('pointercancel', stopDrag);
    viewport.addEventListener('lostpointercapture', stopDrag);
    updateButtons();
  });

  const updateVisualStory = () => {
    const y = window.scrollY;
    parallaxEls.forEach((el, i) => {
      el.style.setProperty('--parallax', `${(i + 1) * y * 0.05}px`);
    });

    document.documentElement.style.setProperty('--landing-emblem-shift', `${Math.min(y, 1200)}px`);

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
      const labels = selected.map((input) => input.dataset.seatLabel || input.value);
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
        summaryLabel.textContent = labels.length ? `Lugares elegidos: ${labels.join(', ')}` : 'Elige uno o dos lugares para continuar con calma.';
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

  const layoutPayload = document.getElementById('layout-editor-payload');
  if (layoutPayload && window.Konva) {
    const stageContainer = document.getElementById('layout-editor-stage');
    const jsonField = document.getElementById('layout-editor-json');
    if (stageContainer && jsonField) {
      const payload = JSON.parse(layoutPayload.textContent || '{}');
      const baseLayout = payload.baseLayout ? JSON.parse(JSON.stringify(payload.baseLayout)) : null;
      const matMarkAsset = payload.matMarkAsset || '/static/tisa-mat-mark.svg';
      const state = {
        layout: JSON.parse(JSON.stringify(payload.layout || {})),
        selection: { type: 'instructor', id: null },
        locked: payload.structureLocked === true,
      };
      state.layout.background = state.layout.background || null;

      const actionButtons = {
        selectInstructor: document.querySelector('[data-layout-action="select-instructor"]'),
        selectBackground: document.querySelector('[data-layout-action="select-background"]'),
        addSeat: document.querySelector('[data-layout-action="add-seat"]'),
        deleteSeat: document.querySelector('[data-layout-action="delete-seat"]'),
        renumberRows: document.querySelector('[data-layout-action="renumber-rows"]'),
        reorderRows: document.querySelector('[data-layout-action="reorder-rows"]'),
        resetBase: document.querySelector('[data-layout-action="reset-base"]'),
        uploadBackground: document.querySelector('[data-layout-action="upload-background"]'),
        replaceBackground: document.querySelector('[data-layout-action="replace-background"]'),
        clearBackground: document.querySelector('[data-layout-action="clear-background"]'),
        zoomIn: document.querySelector('[data-layout-action="zoom-in"]'),
        zoomOut: document.querySelector('[data-layout-action="zoom-out"]'),
        zoomReset: document.querySelector('[data-layout-action="zoom-reset"]'),
      };
      const inspectorFields = {
        viewportScale: document.querySelector('[data-layout-output="viewport-scale"]'),
        selection: document.querySelector('[data-layout-output="selection"]'),
        backgroundStatus: document.querySelector('[data-layout-output="background-status"]'),
        canvasWidth: document.querySelector('[data-layout-input="canvas-width"]'),
        canvasHeight: document.querySelector('[data-layout-input="canvas-height"]'),
        canvasGrid: document.querySelector('[data-layout-input="canvas-grid"]'),
        label: document.querySelector('[data-layout-input="label"]'),
        row: document.querySelector('[data-layout-input="row"]'),
        order: document.querySelector('[data-layout-input="order"]'),
        zone: document.querySelector('[data-layout-input="zone"]'),
        bookable: document.querySelector('[data-layout-input="bookable"]'),
        enabled: document.querySelector('[data-layout-input="enabled"]'),
        backgroundFile: document.getElementById('layout-background-file'),
        backgroundX: document.querySelector('[data-layout-input="background-x"]'),
        backgroundY: document.querySelector('[data-layout-input="background-y"]'),
        backgroundScale: document.querySelector('[data-layout-input="background-scale"]'),
        backgroundOpacity: document.querySelector('[data-layout-input="background-opacity"]'),
      };

      const seatWidth = 114;
      const seatHeight = 58;
      const seatHalfWidth = seatWidth / 2;
      const seatHalfHeight = seatHeight / 2;
      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
      const gridSize = () => Number(state.layout.canvas?.grid || 24);
      const snap = (value) => Math.round(value / gridSize()) * gridSize();
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const isSeatSelection = () => state.selection.type === 'seat';
      const isBackgroundSelection = () => state.selection.type === 'background' && Boolean(state.layout.background);
      const selectedSeat = () => state.layout.seats.find((seat) => seat.id === state.selection.id) || null;
      const selectedBackground = () => state.layout.background || null;
      const nextSeatId = () => `seat-${Math.random().toString(36).slice(2, 10)}`;
      const imageCache = new Map();
      const viewport = { scale: 1 };
      const stageViewport = stageContainer.parentElement;

      const stage = new window.Konva.Stage({
        container: stageContainer,
        width: Number(state.layout.canvas?.width || 1200),
        height: Number(state.layout.canvas?.height || 800),
      });
      const backgroundLayer = new window.Konva.Layer();
      const gridLayer = new window.Konva.Layer();
      const layer = new window.Konva.Layer();
      stage.add(backgroundLayer);
      stage.add(gridLayer);
      stage.add(layer);

      const loadImage = (src) => {
        if (!src) return null;
        if (imageCache.has(src)) return imageCache.get(src);
        const image = new window.Image();
        image.src = src;
        image.addEventListener('load', () => drawLayout());
        imageCache.set(src, image);
        return image;
      };

      const syncViewport = () => {
        if (!stageViewport) return;
        stageContainer.style.transform = `scale(${viewport.scale})`;
        stageContainer.style.transformOrigin = 'top left';
        stageViewport.style.width = `${Math.round(stage.width() * viewport.scale)}px`;
        stageViewport.style.height = `${Math.round(stage.height() * viewport.scale)}px`;
        if (inspectorFields.viewportScale) {
          inspectorFields.viewportScale.value = `${Math.round(viewport.scale * 100)}%`;
          inspectorFields.viewportScale.textContent = `${Math.round(viewport.scale * 100)}%`;
        }
      };

      const setViewportScale = (nextScale) => {
        viewport.scale = clamp(Number(nextScale) || 1, 0.5, 2.5);
        syncViewport();
      };

      const syncCanvasFields = () => {
        if (inspectorFields.canvasWidth) inspectorFields.canvasWidth.value = String(stage.width());
        if (inspectorFields.canvasHeight) inspectorFields.canvasHeight.value = String(stage.height());
        if (inspectorFields.canvasGrid) inspectorFields.canvasGrid.value = String(gridSize());
      };

      const syncJson = () => {
        jsonField.value = JSON.stringify(state.layout);
      };

      const normalizeSeatOrder = () => {
        state.layout.seats.sort((left, right) => {
          if (left.row !== right.row) return left.row.localeCompare(right.row, 'es');
          if (left.order !== right.order) return left.order - right.order;
          if (left.y !== right.y) return left.y - right.y;
          return left.x - right.x;
        });
      };

      const rowLetterByIndex = (index) => String.fromCharCode('A'.charCodeAt(0) + index);
      const setFieldDisabled = (field, disabled) => {
        if (field) field.disabled = disabled;
      };
      const fitBackgroundToStage = (background) => {
        const grid = gridSize();
        const widthLimit = Math.max(stage.width() - grid * 4, grid * 8);
        const heightLimit = Math.max(stage.height() - grid * 4, grid * 8);
        const fittedScale = Math.min(widthLimit / background.assetWidth, heightLimit / background.assetHeight, 1);
        const scale = Number(clamp(fittedScale, 0.2, 2).toFixed(2));
        return {
          ...background,
          x: snap((stage.width() - background.assetWidth * scale) / 2),
          y: snap((stage.height() - background.assetHeight * scale) / 2),
          scale,
          opacity: 0.58,
        };
      };

      const renumberRows = () => {
        const groups = new Map();
        state.layout.seats.forEach((seat) => {
          if (!groups.has(seat.row)) groups.set(seat.row, []);
          groups.get(seat.row).push(seat);
        });
        Array.from(groups.entries()).forEach(([row, seats]) => {
          seats
            .sort((left, right) => left.x - right.x)
            .forEach((seat, index) => {
              seat.order = index + 1;
              seat.label = `${row}${index + 1}`;
            });
        });
        normalizeSeatOrder();
      };

      const reorderRows = () => {
        const rows = Array.from(
          state.layout.seats.reduce((map, seat) => {
            if (!map.has(seat.row)) map.set(seat.row, []);
            map.get(seat.row).push(seat);
            return map;
          }, new Map()).entries(),
        )
          .map(([row, seats]) => ({
            row,
            seats,
            y: seats.reduce((sum, seat) => sum + seat.y, 0) / Math.max(seats.length, 1),
          }))
          .sort((left, right) => left.y - right.y);

        rows.forEach((rowInfo, index) => {
          const nextRow = rowLetterByIndex(index);
          rowInfo.seats.forEach((seat) => {
            seat.row = nextRow;
          });
        });
        renumberRows();
      };

      const drawGrid = () => {
        gridLayer.destroyChildren();
        const width = stage.width();
        const height = stage.height();
        const grid = gridSize();
        for (let x = 0; x <= width; x += grid) {
          gridLayer.add(new window.Konva.Line({
            points: [x, 0, x, height],
            stroke: 'rgba(95, 69, 46, 0.08)',
            strokeWidth: 1,
          }));
        }
        for (let y = 0; y <= height; y += grid) {
          gridLayer.add(new window.Konva.Line({
            points: [0, y, width, y],
            stroke: 'rgba(95, 69, 46, 0.08)',
            strokeWidth: 1,
          }));
        }
        gridLayer.draw();
      };

      const clampSeatPosition = (position) => ({
        x: clamp(snap(position.x), seatHalfWidth, stage.width() - seatHalfWidth),
        y: clamp(snap(position.y), seatHalfHeight, stage.height() - seatHalfHeight),
      });
      const clampInstructorPosition = (position) => ({
        x: clamp(snap(position.x), 76, stage.width() - 76),
        y: clamp(snap(position.y), 26, stage.height() - 26),
      });
      const clampBackgroundPosition = (position, background = selectedBackground()) => {
        if (!background) return { x: snap(position.x), y: snap(position.y) };
        const grid = gridSize();
        const width = background.assetWidth * background.scale;
        const height = background.assetHeight * background.scale;
        return {
          x: clamp(snap(position.x), -width + grid * 2, stage.width() - grid * 2),
          y: clamp(snap(position.y), -height + grid * 2, stage.height() - grid * 2),
        };
      };

      const clampLayoutIntoCanvas = () => {
        state.layout.instructor = {
          ...state.layout.instructor,
          ...clampInstructorPosition(state.layout.instructor),
        };
        state.layout.seats = state.layout.seats.map((seat) => ({
          ...seat,
          ...clampSeatPosition(seat),
        }));
        if (state.layout.background) {
          state.layout.background = {
            ...state.layout.background,
            ...clampBackgroundPosition(state.layout.background, state.layout.background),
          };
        }
      };

      const updateCanvasFromInspector = () => {
        if (state.locked) return;
        const nextWidth = clamp(Number.parseInt(inspectorFields.canvasWidth?.value || stage.width(), 10) || stage.width(), 640, 2400);
        const nextHeight = clamp(Number.parseInt(inspectorFields.canvasHeight?.value || stage.height(), 10) || stage.height(), 480, 1800);
        const nextGrid = clamp(Number.parseInt(inspectorFields.canvasGrid?.value || gridSize(), 10) || gridSize(), 12, 64);
        state.layout.canvas = {
          width: nextWidth,
          height: nextHeight,
          grid: nextGrid,
        };
        stage.width(nextWidth);
        stage.height(nextHeight);
        clampLayoutIntoCanvas();
        syncCanvasFields();
        syncJson();
        syncViewport();
        drawGrid();
        drawLayout();
        syncInspector();
      };

      const syncInspector = () => {
        const seat = selectedSeat();
        const background = selectedBackground();
        if (inspectorFields.selection) {
          inspectorFields.selection.value = seat
            ? `Tapete ${seat.label}`
            : isBackgroundSelection()
            ? 'Fondo del salón'
            : 'Instructora';
        }

        const seatEditable = Boolean(seat) && !state.locked;
        const backgroundEditable = Boolean(background) && !state.locked;
        setFieldDisabled(inspectorFields.label, !seatEditable);
        setFieldDisabled(inspectorFields.row, !seatEditable);
        setFieldDisabled(inspectorFields.order, !seatEditable);
        setFieldDisabled(inspectorFields.zone, !seatEditable);
        setFieldDisabled(inspectorFields.bookable, !seatEditable);
        setFieldDisabled(inspectorFields.enabled, !seatEditable);
        setFieldDisabled(inspectorFields.backgroundX, !backgroundEditable);
        setFieldDisabled(inspectorFields.backgroundY, !backgroundEditable);
        setFieldDisabled(inspectorFields.backgroundScale, !backgroundEditable);
        setFieldDisabled(inspectorFields.backgroundOpacity, !backgroundEditable);
        setFieldDisabled(inspectorFields.canvasWidth, state.locked);
        setFieldDisabled(inspectorFields.canvasHeight, state.locked);
        setFieldDisabled(inspectorFields.canvasGrid, state.locked);

        if (inspectorFields.backgroundStatus) {
          inspectorFields.backgroundStatus.textContent = background
            ? state.locked
              ? 'La foto está bloqueada porque esta clase ya tiene reservas activas.'
              : 'Foto cargada. Puedes arrastrarla o ajustar posición, escala y opacidad.'
            : 'Aún no hay foto cargada.';
        }
        if (actionButtons.selectBackground) actionButtons.selectBackground.disabled = !background;
        if (actionButtons.clearBackground) actionButtons.clearBackground.disabled = !background || state.locked;
        if (actionButtons.replaceBackground) actionButtons.replaceBackground.disabled = state.locked;
        if (actionButtons.uploadBackground) actionButtons.uploadBackground.disabled = state.locked;

        if (seat) {
          if (inspectorFields.label) inspectorFields.label.value = seat.label || '';
          if (inspectorFields.row) inspectorFields.row.value = seat.row || '';
          if (inspectorFields.order) inspectorFields.order.value = String(seat.order || 1);
          if (inspectorFields.zone) inspectorFields.zone.value = seat.zone || 'middle';
          if (inspectorFields.bookable) inspectorFields.bookable.checked = seat.bookable !== false;
          if (inspectorFields.enabled) inspectorFields.enabled.checked = seat.enabled !== false;
        } else {
          if (inspectorFields.label) inspectorFields.label.value = state.layout.instructor?.label || 'Instructora';
          if (inspectorFields.row) inspectorFields.row.value = '';
          if (inspectorFields.order) inspectorFields.order.value = '';
          if (inspectorFields.zone) inspectorFields.zone.value = 'near';
          if (inspectorFields.bookable) inspectorFields.bookable.checked = false;
          if (inspectorFields.enabled) inspectorFields.enabled.checked = true;
        }

        if (background) {
          if (inspectorFields.backgroundX) inspectorFields.backgroundX.value = String(background.x || 0);
          if (inspectorFields.backgroundY) inspectorFields.backgroundY.value = String(background.y || 0);
          if (inspectorFields.backgroundScale) inspectorFields.backgroundScale.value = String(background.scale || 1);
          if (inspectorFields.backgroundOpacity) inspectorFields.backgroundOpacity.value = String(background.opacity ?? 1);
        } else {
          if (inspectorFields.backgroundX) inspectorFields.backgroundX.value = '';
          if (inspectorFields.backgroundY) inspectorFields.backgroundY.value = '';
          if (inspectorFields.backgroundScale) inspectorFields.backgroundScale.value = '';
          if (inspectorFields.backgroundOpacity) inspectorFields.backgroundOpacity.value = '';
        }

        syncCanvasFields();
      };

      const selectInstructor = () => {
        state.selection = { type: 'instructor', id: null };
        syncInspector();
        drawLayout();
      };

      const selectBackground = () => {
        if (!state.layout.background) return;
        state.selection = { type: 'background', id: null };
        syncInspector();
        drawLayout();
      };

      const selectSeat = (seatId) => {
        state.selection = { type: 'seat', id: seatId };
        syncInspector();
        drawLayout();
      };

      const updateSeatFromInspector = () => {
        const seat = selectedSeat();
        if (!seat || state.locked) return;
        seat.label = (inspectorFields.label?.value || seat.label).trim().toUpperCase() || seat.label;
        seat.row = (inspectorFields.row?.value || seat.row).trim().toUpperCase() || seat.row;
        seat.order = Math.max(1, Number.parseInt(inspectorFields.order?.value || seat.order, 10) || 1);
        seat.zone = inspectorFields.zone?.value || seat.zone;
        seat.bookable = Boolean(inspectorFields.bookable?.checked);
        seat.enabled = Boolean(inspectorFields.enabled?.checked);
        normalizeSeatOrder();
        syncJson();
        drawLayout();
        syncInspector();
      };

      const updateBackgroundFromInspector = () => {
        const background = selectedBackground();
        if (!background || state.locked) return;
        background.x = Number.parseInt(inspectorFields.backgroundX?.value || background.x, 10) || 0;
        background.y = Number.parseInt(inspectorFields.backgroundY?.value || background.y, 10) || 0;
        background.scale = clamp(Number.parseFloat(inspectorFields.backgroundScale?.value || background.scale) || background.scale || 1, 0.1, 4);
        background.opacity = clamp(Number.parseFloat(inspectorFields.backgroundOpacity?.value || background.opacity) || background.opacity || 1, 0.1, 1);
        Object.assign(background, clampBackgroundPosition(background, background));
        syncJson();
        drawLayout();
        syncInspector();
      };

      const drawLayout = () => {
        backgroundLayer.destroyChildren();
        layer.destroyChildren();

        const background = selectedBackground();
        if (background) {
          const backgroundImage = loadImage(background.assetUrl);
          const width = background.assetWidth * background.scale;
          const height = background.assetHeight * background.scale;
          const backgroundGroup = new window.Konva.Group({
            x: background.x,
            y: background.y,
            draggable: !state.locked,
            dragBoundFunc: (position) => clampBackgroundPosition(position, background),
          });

          if (backgroundImage?.complete) {
            backgroundGroup.add(new window.Konva.Image({
              image: backgroundImage,
              x: 0,
              y: 0,
              width,
              height,
              opacity: background.opacity,
            }));
          } else {
            backgroundGroup.add(new window.Konva.Rect({
              x: 0,
              y: 0,
              width,
              height,
              fill: 'rgba(217, 224, 210, 0.38)',
            }));
          }

          if (isBackgroundSelection()) {
            backgroundGroup.add(new window.Konva.Rect({
              x: -6,
              y: -6,
              width: width + 12,
              height: height + 12,
              stroke: '#4f6245',
              dash: [10, 8],
              strokeWidth: 3,
              listening: false,
            }));
          }

          backgroundGroup.on('click tap', () => selectBackground());
          backgroundGroup.on('dragmove', () => {
            background.x = backgroundGroup.x();
            background.y = backgroundGroup.y();
            syncJson();
            syncInspector();
          });
          backgroundLayer.add(backgroundGroup);
          backgroundLayer.draw();
        }

        const instructorGroup = new window.Konva.Group({
          x: state.layout.instructor.x,
          y: state.layout.instructor.y,
          draggable: true,
          dragBoundFunc: clampInstructorPosition,
        });
        instructorGroup.add(new window.Konva.Rect({
          x: -76,
          y: -26,
          width: 152,
          height: 52,
          cornerRadius: 24,
          fill: state.selection.type === 'instructor' ? '#2e1d1a' : '#f2e8dd',
          stroke: '#7a5a45',
          strokeWidth: 2,
        }));
        instructorGroup.add(new window.Konva.Text({
          x: -66,
          y: -10,
          width: 132,
          align: 'center',
          text: state.layout.instructor.label || 'Instructora',
          fill: state.selection.type === 'instructor' ? '#fff8f0' : '#2e1d1a',
          fontStyle: 'bold',
          fontSize: 16,
        }));
        instructorGroup.on('click tap', () => selectInstructor());
        instructorGroup.on('dragmove', () => {
          state.layout.instructor.x = instructorGroup.x();
          state.layout.instructor.y = instructorGroup.y();
          syncJson();
        });
        layer.add(instructorGroup);

        state.layout.seats.forEach((seat) => {
          const seatGroup = new window.Konva.Group({
            x: seat.x,
            y: seat.y,
            draggable: !state.locked,
            dragBoundFunc: clampSeatPosition,
            rotation: seat.rotation || 0,
          });
          const isSelected = state.selection.type === 'seat' && state.selection.id === seat.id;
          const fill = !seat.enabled || seat.bookable === false ? '#d8d2c8' : isSelected ? '#5a6f4d' : '#f4f0e8';
          const textFill = !seat.enabled || seat.bookable === false ? '#7b7268' : isSelected ? '#f7faf3' : '#3e4637';
          const markImage = loadImage(matMarkAsset);

          seatGroup.add(new window.Konva.Rect({
            x: -seatHalfWidth,
            y: -seatHalfHeight,
            width: seatWidth,
            height: seatHeight,
            cornerRadius: 24,
            fill,
            stroke: seat.zone === 'near' ? '#9d6646' : seat.zone === 'back' ? '#64724f' : '#827d5b',
            strokeWidth: isSelected ? 4 : 2,
          }));

          if (markImage?.complete) {
            seatGroup.add(new window.Konva.Image({
              image: markImage,
              x: -32,
              y: -18,
              width: 64,
              height: 24,
              opacity: !seat.enabled || seat.bookable === false ? 0.42 : isSelected ? 0.22 : 0.38,
              listening: false,
            }));
          } else {
            seatGroup.add(new window.Konva.Text({
              x: -36,
              y: -14,
              width: 72,
              align: 'center',
              text: 'TISA',
              fill: isSelected ? 'rgba(247, 250, 243, 0.28)' : 'rgba(92, 101, 81, 0.42)',
              fontStyle: 'bold',
              fontSize: 14,
              listening: false,
            }));
          }

          seatGroup.add(new window.Konva.Text({
            x: -42,
            y: 9,
            width: 84,
            align: 'center',
            text: seat.label,
            fill: textFill,
            fontStyle: 'bold',
            fontSize: 15,
            listening: false,
          }));
          seatGroup.on('click tap', () => selectSeat(seat.id));
          seatGroup.on('dragmove', () => {
            seat.x = seatGroup.x();
            seat.y = seatGroup.y();
            syncJson();
          });
          layer.add(seatGroup);
        });

        layer.draw();
      };

      const openBackgroundPicker = () => {
        if (state.locked) return;
        inspectorFields.backgroundFile?.click();
      };

      actionButtons.selectInstructor?.addEventListener('click', () => selectInstructor());
      actionButtons.selectBackground?.addEventListener('click', () => selectBackground());
      actionButtons.zoomIn?.addEventListener('click', () => setViewportScale(viewport.scale + 0.1));
      actionButtons.zoomOut?.addEventListener('click', () => setViewportScale(viewport.scale - 0.1));
      actionButtons.zoomReset?.addEventListener('click', () => setViewportScale(1));
      actionButtons.addSeat?.addEventListener('click', () => {
        if (state.locked) return;
        const grid = gridSize();
        const seat = selectedSeat();
        const row = seat?.row || 'A';
        const nextOrder = state.layout.seats.filter((item) => item.row === row).length + 1;
        state.layout.seats.push({
          id: nextSeatId(),
          label: `${row}${nextOrder}`,
          row,
          order: nextOrder,
          zone: seat?.zone || 'middle',
          x: clamp(snap((seat?.x || stage.width() / 2) + grid * 2), seatHalfWidth, stage.width() - seatHalfWidth),
          y: clamp(snap(seat?.y || stage.height() / 2), seatHalfHeight, stage.height() - seatHalfHeight),
          rotation: 0,
          bookable: true,
          enabled: true,
        });
        normalizeSeatOrder();
        syncJson();
        drawLayout();
      });
      actionButtons.deleteSeat?.addEventListener('click', () => {
        if (state.locked || !isSeatSelection()) return;
        state.layout.seats = state.layout.seats.filter((seat) => seat.id !== state.selection.id);
        selectInstructor();
        syncJson();
        drawLayout();
      });
      actionButtons.renumberRows?.addEventListener('click', () => {
        if (state.locked) return;
        renumberRows();
        syncJson();
        drawLayout();
        syncInspector();
      });
      actionButtons.reorderRows?.addEventListener('click', () => {
        if (state.locked) return;
        reorderRows();
        syncJson();
        drawLayout();
        syncInspector();
      });
      actionButtons.resetBase?.addEventListener('click', () => {
        if (state.locked || !baseLayout) return;
        state.layout = clone(baseLayout);
        state.layout.background = state.layout.background || null;
        stage.width(Number(state.layout.canvas?.width || 1200));
        stage.height(Number(state.layout.canvas?.height || 800));
        selectInstructor();
        syncJson();
        syncViewport();
        drawGrid();
        drawLayout();
        syncInspector();
      });
      actionButtons.uploadBackground?.addEventListener('click', openBackgroundPicker);
      actionButtons.replaceBackground?.addEventListener('click', openBackgroundPicker);
      actionButtons.clearBackground?.addEventListener('click', () => {
        if (state.locked || !state.layout.background) return;
        state.layout.background = null;
        if (state.selection.type === 'background') {
          state.selection = { type: 'instructor', id: null };
        }
        syncJson();
        drawLayout();
        syncInspector();
      });

      inspectorFields.backgroundFile?.addEventListener('change', async () => {
        const file = inspectorFields.backgroundFile.files?.[0];
        if (!file) return;
        if (inspectorFields.backgroundStatus) {
          inspectorFields.backgroundStatus.textContent = 'Subiendo foto del salón...';
        }
        try {
          const formData = new window.FormData();
          formData.append('backgroundImage', file);
          const response = await window.fetch('/admin/layout-assets/background', {
            method: 'POST',
            body: formData,
            headers: { Accept: 'application/json' },
          });
          const upload = await response.json();
          if (!response.ok) {
            throw new Error(upload.error || 'No se pudo subir la foto.');
          }
          state.layout.background = fitBackgroundToStage(upload);
          state.selection = { type: 'background', id: null };
          syncJson();
          drawLayout();
          syncInspector();
        } catch (error) {
          if (inspectorFields.backgroundStatus) {
            inspectorFields.backgroundStatus.textContent = error.message || 'No se pudo subir la foto.';
          }
        } finally {
          inspectorFields.backgroundFile.value = '';
        }
      });

      Object.entries(inspectorFields).forEach(([key, element]) => {
        if (!element || ['viewportScale', 'selection', 'backgroundStatus', 'backgroundFile'].includes(key)) return;
        if (['canvasWidth', 'canvasHeight', 'canvasGrid'].includes(key)) {
          element.addEventListener('input', updateCanvasFromInspector);
          element.addEventListener('change', updateCanvasFromInspector);
          return;
        }
        if (key.startsWith('background')) {
          element.addEventListener('input', updateBackgroundFromInspector);
          element.addEventListener('change', updateBackgroundFromInspector);
          return;
        }
        element.addEventListener('input', updateSeatFromInspector);
        element.addEventListener('change', updateSeatFromInspector);
      });

      syncJson();
      syncViewport();
      syncCanvasFields();
      drawGrid();
      drawLayout();
      syncInspector();
      window.addEventListener('resize', drawGrid);
    }
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
