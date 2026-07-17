(() => {
  const privacyNotice = document.querySelector('[data-cookie-notice]');
  const privacyNoticeDismiss = privacyNotice?.querySelector('[data-cookie-notice-dismiss]');

  privacyNoticeDismiss?.addEventListener('click', () => {
    try {
      window.localStorage.setItem('tisa.privacy-notice.v1', 'acknowledged');
    } catch (error) {
      // El cierre funciona durante esta visita aunque el almacenamiento esté bloqueado.
    }
    document.documentElement.classList.add('privacy-notice-seen');
    privacyNotice.hidden = true;
  });

  const simBanner = document.querySelector('.sim-banner');
  const siteHeader = document.querySelector('.site-header, .classes-site-header, .seat-floorplan-header');
  const themeColor = (name, fallback) => {
    const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };

  const syncFixedChromeOffset = () => {
    const simBannerHeight = simBanner ? simBanner.getBoundingClientRect().height : 0;
    const siteHeaderHeight = siteHeader ? siteHeader.getBoundingClientRect().height : 0;
    const classesToolbar = document.querySelector('.classes-toolbar');
    const classesToolbarHeight = classesToolbar ? classesToolbar.getBoundingClientRect().height : 0;
    const totalOffset = simBannerHeight + siteHeaderHeight;
    document.documentElement.style.setProperty('--sim-banner-height', `${simBannerHeight}px`);
    document.documentElement.style.setProperty('--site-header-height', `${siteHeaderHeight}px`);
    document.documentElement.style.setProperty('--classes-toolbar-height', `${classesToolbarHeight}px`);
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

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-scroll-target]');
    if (!el) return;
    const target = el.dataset.scrollTarget;
    if (!target) return;
    if (el.classList.contains('scroll-hero') && event.target.closest('a, button, input, textarea, select')) return;
    if (el.matches('a')) event.preventDefault();
    scrollToTarget(target);
  });

  const prefetchedPublicRoutes = new Set();
  const prefetchPublicRoute = (link) => {
    if (!link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href, window.location.origin);
    if (url.origin !== window.location.origin || !['/', '/classes'].includes(url.pathname)) return;
    url.hash = '';
    const key = url.href;
    if (key === `${window.location.origin}${window.location.pathname}${window.location.search}` || prefetchedPublicRoutes.has(key)) return;
    prefetchedPublicRoutes.add(key);
    const hint = document.createElement('link');
    hint.rel = 'prefetch';
    hint.href = key;
    hint.as = 'document';
    document.head.appendChild(hint);
  };

  document.addEventListener('pointerover', (event) => prefetchPublicRoute(event.target.closest('a')), { passive: true });
  document.addEventListener('touchstart', (event) => prefetchPublicRoute(event.target.closest('a')), { passive: true });

  const setupResponsiveMenu = (toggle, menu, selectors) => {
    if (!toggle || !menu) return;
    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
      toggle.classList.toggle('is-open', open);
      menu.classList.toggle('is-open', open);
    };

    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    menu.addEventListener('click', (event) => {
      if (event.target.closest('a, button')) setOpen(false);
    });

    document.addEventListener('click', (event) => {
      if (!menu.classList.contains('is-open')) return;
      if (event.target.closest(selectors)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });
  };

  setupResponsiveMenu(
    document.querySelector('[data-classes-menu-toggle]'),
    document.querySelector('[data-classes-menu]'),
    '[data-classes-menu], [data-classes-menu-toggle]',
  );
  setupResponsiveMenu(
    document.querySelector('[data-nav-menu-toggle]'),
    document.querySelector('[data-nav-menu]'),
    '[data-nav-menu], [data-nav-menu-toggle]',
  );

  const validAgendaIntensities = ['suave', 'baja', 'media-alta'];
  const readAgendaIntensityFilters = (url = window.location.href) => {
    const values = new URL(url, window.location.origin).searchParams.get('intensity') || '';
    return new Set(values.split(',').filter((value) => validAgendaIntensities.includes(value)));
  };
  const activeAgendaIntensityFilters = readAgendaIntensityFilters();

  const syncAgendaIntensityUrl = () => {
    if (window.location.pathname !== '/classes') return;
    const url = new URL(window.location.href);
    const ordered = validAgendaIntensities.filter((value) => activeAgendaIntensityFilters.has(value));
    if (ordered.length) url.searchParams.set('intensity', ordered.join(','));
    else url.searchParams.delete('intensity');
    window.history.replaceState({ ...(window.history.state || {}), tisaAgenda: true }, '', url);
  };

  const setupClassesAgenda = () => {
    const cleanups = [];
    const mobileDaySelector = document.querySelector('[data-classes-day-selector]');
    const mobileDayStack = document.querySelector('[data-classes-day-stack]');
    if (mobileDaySelector && mobileDayStack) {
    const dayOptions = Array.from(mobileDaySelector.querySelectorAll('[data-classes-day-option]'));
    const dayPanels = Array.from(mobileDayStack.querySelectorAll('[data-classes-day-marker]'));
    const dayStorageKey = `tisa:classes-day:${window.location.pathname}${window.location.search}`;

    const centerDayOption = (option, behavior = 'smooth') => {
      if (!option || !window.matchMedia('(max-width: 760px)').matches) return;
      const targetLeft = option.offsetLeft - (mobileDaySelector.clientWidth - option.offsetWidth) / 2;
      const maxLeft = Math.max(0, mobileDaySelector.scrollWidth - mobileDaySelector.clientWidth);
      mobileDaySelector.scrollTo({
        left: Math.max(0, Math.min(targetLeft, maxLeft)),
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : behavior,
      });
    };

    const activateDay = (index, { focus = false, center = true, behavior = 'smooth' } = {}) => {
      const safeIndex = Math.max(0, Math.min(index, dayPanels.length - 1));
      dayOptions.forEach((option, optionIndex) => {
        const isActive = optionIndex === safeIndex;
        option.classList.toggle('is-active', isActive);
        option.setAttribute('aria-current', isActive ? 'date' : 'false');
        option.tabIndex = isActive ? 0 : -1;
      });
      dayPanels.forEach((panel, panelIndex) => {
        const isActive = panelIndex === safeIndex;
        panel.classList.toggle('is-active-mobile-day', isActive);
        panel.hidden = window.matchMedia('(max-width: 760px)').matches && !isActive;
      });
      try {
        window.sessionStorage.setItem(dayStorageKey, String(safeIndex));
      } catch {
        // Browsers can block storage in strict privacy modes.
      }
      if (focus) dayOptions[safeIndex]?.focus({ preventScroll: true });
      if (center) window.requestAnimationFrame(() => centerDayOption(dayOptions[safeIndex], behavior));
    };

    let initialDay = 0;
    try {
      const savedDay = Number.parseInt(window.sessionStorage.getItem(dayStorageKey) || '0', 10);
      if (Number.isInteger(savedDay)) initialDay = savedDay;
    } catch {
      // Keep the first available day selected.
    }

    document.body.classList.add('has-mobile-day-paging');
    mobileDayStack.classList.add('is-mobile-paged');
    activateDay(initialDay, { behavior: 'auto' });

    dayOptions.forEach((option, index) => {
      option.addEventListener('click', () => activateDay(index));
      option.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const targetIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? dayOptions.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + dayOptions.length) % dayOptions.length;
        activateDay(targetIndex, { focus: true });
      });
    });

    const mobileDayQuery = window.matchMedia('(max-width: 760px)');
    const syncDayPanelVisibility = () => {
      const activeIndex = Math.max(0, dayOptions.findIndex((option) => option.classList.contains('is-active')));
      dayPanels.forEach((panel, index) => {
        panel.hidden = mobileDayQuery.matches && index !== activeIndex;
      });
    };
    mobileDayQuery.addEventListener?.('change', syncDayPanelVisibility);
    cleanups.push(() => mobileDayQuery.removeEventListener?.('change', syncDayPanelVisibility));
    syncDayPanelVisibility();
    }

    const mobileDaySticky = document.querySelector('[data-classes-day-sticky]');
    if (mobileDaySticky) {
    const titleTarget = mobileDaySticky.querySelector('[data-classes-day-sticky-title]');
    const metaTarget = mobileDaySticky.querySelector('[data-classes-day-sticky-meta]');
    const markers = Array.from(document.querySelectorAll('[data-classes-day-marker]'));
    const mobileQuery = window.matchMedia('(max-width: 760px)');

    const setActiveMarker = (marker) => {
      if (!marker || !titleTarget || !metaTarget) return;
      titleTarget.textContent = marker.dataset.dayTitle || titleTarget.textContent;
      metaTarget.textContent = marker.dataset.dayMeta || metaTarget.textContent;
      markers.forEach((item) => item.classList.toggle('is-current-mobile-day', item === marker));
    };

    const getProbeY = () => {
      const styles = window.getComputedStyle(document.documentElement);
      const chrome = parseFloat(styles.getPropertyValue('--fixed-chrome-offset')) || 0;
      return chrome + mobileDaySticky.getBoundingClientRect().height + 18;
    };

    const syncMobileDaySticky = () => {
      if (!mobileQuery.matches || markers.length === 0) {
        mobileDaySticky.classList.remove('is-visible');
        return;
      }

      const probeY = getProbeY();
      let active = markers.find((marker) => {
        const rect = marker.getBoundingClientRect();
        return rect.top <= probeY && rect.bottom > probeY;
      });

      if (!active) {
        active = markers
          .map((marker) => ({ marker, distance: Math.abs(marker.getBoundingClientRect().top - probeY) }))
          .sort((a, b) => a.distance - b.distance)[0]?.marker;
      }

      setActiveMarker(active);
      const board = document.getElementById('classes-editorial-grid');
      const boardRect = board?.getBoundingClientRect();
      mobileDaySticky.classList.toggle('is-visible', Boolean(boardRect && boardRect.top < window.innerHeight && boardRect.bottom > probeY));
    };

    let stickyFrame = 0;
    const scheduleStickySync = () => {
      if (stickyFrame) return;
      stickyFrame = window.requestAnimationFrame(() => {
        stickyFrame = 0;
        syncMobileDaySticky();
      });
    };

    let markerObserver = null;
    if ('IntersectionObserver' in window) {
      markerObserver = new IntersectionObserver(scheduleStickySync, {
        root: null,
        rootMargin: '-18% 0px -58% 0px',
        threshold: [0, 0.1, 0.35, 0.7, 1],
      });
      markers.forEach((marker) => markerObserver.observe(marker));
    }

    window.addEventListener('scroll', scheduleStickySync, { passive: true });
    window.addEventListener('resize', scheduleStickySync);
    mobileQuery.addEventListener?.('change', scheduleStickySync);
    cleanups.push(() => {
      markerObserver?.disconnect();
      window.removeEventListener('scroll', scheduleStickySync);
      window.removeEventListener('resize', scheduleStickySync);
      mobileQuery.removeEventListener?.('change', scheduleStickySync);
      if (stickyFrame) window.cancelAnimationFrame(stickyFrame);
    });
    syncMobileDaySticky();
    }

    const intensityButtons = Array.from(document.querySelectorAll('[data-agenda-intensity-filter]'));
    const intensityCards = Array.from(document.querySelectorAll('[data-agenda-intensity-card]'));
    const intensityStatus = document.querySelector('[data-agenda-filter-status]');
    const intensityEmpty = document.querySelector('[data-agenda-filter-empty]');
    const intensityClear = document.querySelector('[data-agenda-filter-clear]');

    if (intensityButtons.length) {
      const getCardCount = (card) => Number.parseInt(card.dataset.agendaOccurrenceCount || '1', 10) || 1;
      const isCardVisibleForFilter = (card) => (
        activeAgendaIntensityFilters.size === 0 || activeAgendaIntensityFilters.has(card.dataset.agendaIntensity)
      );

      const applyIntensityFilters = () => {
        let visibleTotal = 0;
        const availableCounts = new Map();
        let availableTotal = 0;
        intensityCards.forEach((card) => {
          const count = getCardCount(card);
          availableTotal += count;
          availableCounts.set(card.dataset.agendaIntensity, (availableCounts.get(card.dataset.agendaIntensity) || 0) + count);
        });
        intensityCards.forEach((card) => {
          const visible = isCardVisibleForFilter(card);
          card.hidden = !visible;
          card.classList.toggle('is-filtered-out', !visible);
          if (visible) visibleTotal += getCardCount(card);
        });

        intensityButtons.forEach((button) => {
          const value = button.dataset.agendaIntensityFilter;
          const availableCount = value === 'all' ? availableTotal : (availableCounts.get(value) || 0);
          const selected = value === 'all'
            ? activeAgendaIntensityFilters.size === 0
            : activeAgendaIntensityFilters.has(value);
          const countTarget = button.querySelector('small');
          if (countTarget) countTarget.textContent = String(availableCount);
          if (value !== 'all') button.disabled = availableCount === 0;
          button.classList.toggle('is-active', selected);
          button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });

        const dayContainers = Array.from(document.querySelectorAll('.classes-timetable-day, .classes-month-day, .classes-day-column'));
        dayContainers.forEach((day) => {
          const visibleInDay = Array.from(day.querySelectorAll('[data-agenda-intensity-card]'))
            .filter((card) => !card.hidden)
            .reduce((total, card) => total + getCardCount(card), 0);
          day.classList.toggle('is-filter-empty', activeAgendaIntensityFilters.size > 0 && visibleInDay === 0);
          day.dataset.filteredOccurrenceCount = String(visibleInDay);
        });

        const dayOptions = Array.from(document.querySelectorAll('[data-classes-day-option]'));
        const timetableDays = Array.from(document.querySelectorAll('.classes-timetable-day'));
        dayOptions.forEach((option, index) => {
          const count = Number.parseInt(timetableDays[index]?.dataset.filteredOccurrenceCount || '0', 10) || 0;
          const countTarget = option.querySelector('small');
          if (!option.dataset.agendaBaseLabel) option.dataset.agendaBaseLabel = option.getAttribute('aria-label') || '';
          if (countTarget) countTarget.textContent = String(count);
          option.setAttribute(
            'aria-label',
            activeAgendaIntensityFilters.size > 0
              ? `${option.dataset.agendaBaseLabel.split(',')[0]}, ${count} ${count === 1 ? 'horario visible' : 'horarios visibles'}`
              : option.dataset.agendaBaseLabel,
          );
          option.classList.toggle('has-no-filter-results', activeAgendaIntensityFilters.size > 0 && count === 0);
        });

        if (activeAgendaIntensityFilters.size > 0 && dayOptions.length) {
          const activeIndex = dayOptions.findIndex((option) => option.classList.contains('is-active'));
          const activeCount = Number.parseInt(timetableDays[activeIndex]?.dataset.filteredOccurrenceCount || '0', 10) || 0;
          if (activeCount === 0) {
            const nextIndex = timetableDays.findIndex((day) => Number.parseInt(day.dataset.filteredOccurrenceCount || '0', 10) > 0);
            if (nextIndex >= 0) dayOptions[nextIndex]?.click();
          }
        }

        if (intensityStatus) {
          const noun = visibleTotal === 1 ? 'horario visible' : 'horarios visibles';
          intensityStatus.textContent = activeAgendaIntensityFilters.size
            ? `${visibleTotal} ${noun}`
            : `${visibleTotal} ${visibleTotal === 1 ? 'horario' : 'horarios'}`;
        }
        if (intensityClear) {
          intensityClear.hidden = activeAgendaIntensityFilters.size === 0;
          intensityClear.disabled = activeAgendaIntensityFilters.size === 0;
        }
        if (intensityEmpty) intensityEmpty.hidden = !(activeAgendaIntensityFilters.size > 0 && visibleTotal === 0);
        document.querySelector('.classes-board')?.classList.toggle(
          'has-empty-intensity-filter',
          activeAgendaIntensityFilters.size > 0 && visibleTotal === 0,
        );
      };

      intensityButtons.forEach((button) => {
        const handleIntensityClick = () => {
          const value = button.dataset.agendaIntensityFilter;
          if (value === 'all') activeAgendaIntensityFilters.clear();
          else if (activeAgendaIntensityFilters.has(value)) activeAgendaIntensityFilters.delete(value);
          else activeAgendaIntensityFilters.add(value);
          syncAgendaIntensityUrl();
          applyIntensityFilters();
        };
        button.addEventListener('click', handleIntensityClick);
        cleanups.push(() => button.removeEventListener('click', handleIntensityClick));
      });

      if (intensityClear) {
        const handleIntensityClear = () => {
          activeAgendaIntensityFilters.clear();
          syncAgendaIntensityUrl();
          applyIntensityFilters();
        };
        intensityClear.addEventListener('click', handleIntensityClear);
        cleanups.push(() => intensityClear.removeEventListener('click', handleIntensityClear));
      }

      applyIntensityFilters();
    }

    syncFixedChromeOffset();
    return () => cleanups.forEach((cleanup) => cleanup());
  };

  let cleanupClassesAgenda = setupClassesAgenda();

  const classesShell = document.querySelector('.classes-editorial-shell');
  if (classesShell) {
    let agendaRequestController = null;
    let agendaRequestSequence = 0;

    const setAgendaLoading = (loading) => {
      classesShell.classList.toggle('is-agenda-loading', loading);
      const toolbar = document.querySelector('.classes-toolbar');
      const board = document.querySelector('.classes-board');
      toolbar?.setAttribute('aria-busy', loading ? 'true' : 'false');
      board?.setAttribute('aria-busy', loading ? 'true' : 'false');
    };

    const showAgendaError = () => {
      document.querySelector('.classes-agenda-client-error')?.remove();
      const message = document.createElement('p');
      message.className = 'classes-agenda-client-error';
      message.setAttribute('role', 'alert');
      message.textContent = 'No pudimos actualizar la agenda. Revisa tu conexión e inténtalo de nuevo.';
      document.querySelector('.classes-control-deck')?.insertAdjacentElement('afterend', message);
    };

    const replaceAgendaContent = (nextDocument) => {
      const requiredSelectors = [
        '.classes-metric-row',
        '.classes-spotlight-card',
        '.classes-control-deck',
        '.classes-board',
      ];

      requiredSelectors.forEach((selector) => {
        const current = document.querySelector(selector);
        const next = nextDocument.querySelector(selector);
        if (!current || !next) throw new Error(`Falta el fragmento dinámico ${selector}`);
        current.replaceWith(next.cloneNode(true));
      });

      const currentStatus = document.querySelector('.classes-status-banner');
      const nextStatus = nextDocument.querySelector('.classes-status-banner');
      currentStatus?.remove();
      if (nextStatus) {
        document.querySelector('.classes-board')?.insertAdjacentElement('beforebegin', nextStatus.cloneNode(true));
      }

      const currentDock = document.querySelector('.classes-mobile-dock');
      const nextDock = nextDocument.querySelector('.classes-mobile-dock');
      if (currentDock && nextDock) currentDock.replaceWith(nextDock.cloneNode(true));

      document.title = nextDocument.title || document.title;
      document.querySelector('.classes-board')?.classList.add('is-agenda-entering');
      document.querySelector('.classes-control-deck')?.classList.add('is-agenda-entering');
    };

    const navigateAgenda = async (href, { historyMode = 'push', focusLabel = '' } = {}) => {
      const targetUrl = new URL(href, window.location.origin);
      if (targetUrl.origin !== window.location.origin || targetUrl.pathname !== '/classes') return false;
      if (historyMode === 'none') {
        activeAgendaIntensityFilters.clear();
        readAgendaIntensityFilters(targetUrl).forEach((value) => activeAgendaIntensityFilters.add(value));
      } else {
        const orderedIntensities = validAgendaIntensities.filter((value) => activeAgendaIntensityFilters.has(value));
        if (orderedIntensities.length) targetUrl.searchParams.set('intensity', orderedIntensities.join(','));
        else targetUrl.searchParams.delete('intensity');
      }
      if (historyMode === 'push' && targetUrl.href === window.location.href) return true;

      agendaRequestController?.abort();
      agendaRequestController = new AbortController();
      const requestSequence = ++agendaRequestSequence;
      const scrollPosition = { x: window.scrollX, y: window.scrollY };
      setAgendaLoading(true);
      document.querySelector('.classes-agenda-client-error')?.remove();

      try {
        const response = await fetch(targetUrl, {
          signal: agendaRequestController.signal,
          headers: { 'X-Requested-With': 'TISA-Agenda' },
        });
        if (!response.ok) throw new Error(`Agenda HTTP ${response.status}`);
        const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (requestSequence !== agendaRequestSequence) return true;

        cleanupClassesAgenda();
        if (historyMode === 'push') window.history.pushState({ tisaAgenda: true }, '', targetUrl);
        if (historyMode === 'replace') window.history.replaceState({ tisaAgenda: true }, '', targetUrl);
        replaceAgendaContent(nextDocument);
        cleanupClassesAgenda = setupClassesAgenda();
        window.scrollTo({ left: scrollPosition.x, top: scrollPosition.y, behavior: 'auto' });

        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            document.querySelector('.classes-board')?.classList.remove('is-agenda-entering');
            document.querySelector('.classes-control-deck')?.classList.remove('is-agenda-entering');
          });
        });

        if (focusLabel) {
          const nextFocus = Array.from(document.querySelectorAll('.classes-toolbar__actions a, .classes-mobile-nav a'))
            .find((link) => (link.getAttribute('aria-label') || link.textContent.trim()) === focusLabel);
          nextFocus?.focus({ preventScroll: true });
        }
        return true;
      } catch (error) {
        if (error.name === 'AbortError') return true;
        showAgendaError();
        return true;
      } finally {
        if (requestSequence === agendaRequestSequence) {
          setAgendaLoading(false);
          syncFixedChromeOffset();
        }
      }
    };

    window.history.replaceState({ ...(window.history.state || {}), tisaAgenda: true }, '', window.location.href);

    document.addEventListener('click', (event) => {
      const link = event.target.closest('.classes-toolbar__actions a, .classes-mobile-nav a');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const url = new URL(link.href, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname !== '/classes') return;
      event.preventDefault();
      const focusLabel = event.detail === 0 ? (link.getAttribute('aria-label') || link.textContent.trim()) : '';
      navigateAgenda(url.href, { historyMode: 'push', focusLabel });
    });

    window.addEventListener('popstate', () => {
      if (window.location.pathname === '/classes') navigateAgenda(window.location.href, { historyMode: 'none' });
    });
  }

  const trainerAgendaToolbar = document.querySelector('[data-trainer-agenda-toolbar]');
  const trainerWorkspace = trainerAgendaToolbar?.closest('.system-shell');
  if (trainerAgendaToolbar && trainerWorkspace) {
    let trainerAgendaController = null;
    let trainerAgendaSequence = 0;

    const setTrainerAgendaLoading = (loading) => {
      trainerWorkspace.classList.toggle('is-trainer-agenda-loading', loading);
      document.querySelector('[data-trainer-agenda-toolbar]')?.setAttribute('aria-busy', loading ? 'true' : 'false');
      document.querySelector('[data-trainer-agenda-content]')?.setAttribute('aria-busy', loading ? 'true' : 'false');
    };

    const showTrainerAgendaError = () => {
      document.querySelector('.trainer-agenda-client-error')?.remove();
      const message = document.createElement('p');
      message.className = 'trainer-agenda-client-error';
      message.setAttribute('role', 'alert');
      message.textContent = 'No pudimos actualizar la agenda. Conservamos la vista actual para que puedas intentarlo de nuevo.';
      document.querySelector('[data-trainer-agenda-toolbar]')?.insertAdjacentElement('afterend', message);
    };

    const navigateTrainerAgenda = async (href, { historyMode = 'push', focusLabel = '' } = {}) => {
      const targetUrl = new URL(href, window.location.origin);
      if (targetUrl.origin !== window.location.origin || targetUrl.pathname !== '/trainer/classes') return false;
      if (historyMode === 'push' && targetUrl.href === window.location.href) return true;

      trainerAgendaController?.abort();
      trainerAgendaController = new AbortController();
      const requestSequence = ++trainerAgendaSequence;
      const scrollPosition = { left: window.scrollX, top: window.scrollY };
      setTrainerAgendaLoading(true);
      document.querySelector('.trainer-agenda-client-error')?.remove();

      try {
        const response = await fetch(targetUrl, {
          signal: trainerAgendaController.signal,
          headers: { 'X-Requested-With': 'TISA-Trainer-Agenda' },
        });
        const responseUrl = new URL(response.url, window.location.origin);
        if (responseUrl.pathname !== '/trainer/classes') {
          window.location.assign(responseUrl.href);
          return true;
        }
        if (!response.ok) throw new Error(`Trainer agenda HTTP ${response.status}`);

        const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
        const nextToolbar = nextDocument.querySelector('[data-trainer-agenda-toolbar]');
        const nextContent = nextDocument.querySelector('[data-trainer-agenda-content]');
        if (!nextToolbar || !nextContent) throw new Error('La respuesta no contiene la agenda del trainer.');
        if (requestSequence !== trainerAgendaSequence) return true;

        if (historyMode === 'push') window.history.pushState({ tisaTrainerAgenda: true }, '', targetUrl);
        if (historyMode === 'replace') window.history.replaceState({ tisaTrainerAgenda: true }, '', targetUrl);

        document.querySelector('[data-trainer-agenda-toolbar]')?.replaceWith(nextToolbar.cloneNode(true));
        document.querySelector('[data-trainer-agenda-content]')?.replaceWith(nextContent.cloneNode(true));
        document.title = nextDocument.title || document.title;
        window.scrollTo({ ...scrollPosition, behavior: 'auto' });

        const insertedToolbar = document.querySelector('[data-trainer-agenda-toolbar]');
        const insertedContent = document.querySelector('[data-trainer-agenda-content]');
        insertedToolbar?.classList.add('is-state-entering');
        insertedContent?.classList.add('is-state-entering');
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            insertedToolbar?.classList.remove('is-state-entering');
            insertedContent?.classList.remove('is-state-entering');
          });
        });

        if (focusLabel) {
          const nextFocus = Array.from(document.querySelectorAll('.calendar-toolbar-actions a'))
            .find((link) => (link.getAttribute('aria-label') || link.textContent.trim()) === focusLabel);
          nextFocus?.focus({ preventScroll: true });
        }
        return true;
      } catch (error) {
        if (error.name === 'AbortError') return true;
        showTrainerAgendaError();
        return true;
      } finally {
        if (requestSequence === trainerAgendaSequence) setTrainerAgendaLoading(false);
      }
    };

    window.history.replaceState({ ...(window.history.state || {}), tisaTrainerAgenda: true }, '', window.location.href);

    document.addEventListener('click', (event) => {
      const link = event.target.closest('.calendar-toolbar-actions a');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const url = new URL(link.href, window.location.origin);
      if (url.pathname !== '/trainer/classes' || url.origin !== window.location.origin) return;
      event.preventDefault();
      const focusLabel = event.detail === 0 ? (link.getAttribute('aria-label') || link.textContent.trim()) : '';
      navigateTrainerAgenda(url.href, { historyMode: 'push', focusLabel });
    });

    window.addEventListener('popstate', () => {
      if (window.location.pathname === '/trainer/classes') {
        navigateTrainerAgenda(window.location.href, { historyMode: 'none' });
      }
    });
  }

  if (window.location.hash === '#classes-editorial-grid') {
    requestAnimationFrame(() => {
      scrollToTarget('classes-editorial-grid');
    });
    window.setTimeout(() => {
      scrollToTarget('classes-editorial-grid');
    }, 350);
  }

  const classesScrollKey = 'tisa:classes-scroll';
  const isClassesPage = document.body.classList.contains('classes-editorial-page');
  const saveClassesScroll = () => {
    if (!isClassesPage) return;
    const classesPath = `${window.location.pathname}${window.location.search}`;
    try {
      window.sessionStorage.setItem(
        classesScrollKey,
        JSON.stringify({ path: classesPath, y: Math.max(0, Math.round(window.scrollY)), savedAt: Date.now() }),
      );
    } catch {
      // Browsers can block storage in strict privacy modes.
    }
  };

  if (isClassesPage) {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(classesScrollKey) || 'null');
      const canRestore = saved
        && saved.path === `${window.location.pathname}${window.location.search}`
        && Number.isFinite(saved.y)
        && Date.now() - Number(saved.savedAt || 0) < 30 * 60 * 1000;
      if (canRestore) {
        requestAnimationFrame(() => {
          window.scrollTo({ top: Math.max(0, saved.y), behavior: 'auto' });
        });
      }
    } catch {
      // Ignore malformed storage and keep native browser behavior.
    }
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-preserve-classes-scroll]');
    if (!link) return;
    saveClassesScroll();
    try {
      const url = new URL(link.href, window.location.origin);
      if (url.origin === window.location.origin && url.pathname === '/booking/seats') {
        const classesPath = `${window.location.pathname}${window.location.search}`;
        url.searchParams.set('returnTo', `${classesPath}#classes-editorial-grid`);
        link.href = url.toString();
      }
    } catch {
      // Keep the original href if URL parsing fails.
    }
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

  if ('IntersectionObserver' in window) {
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
  } else {
    revealEls.forEach((el) => el.classList.add('show'));
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
    const totalLabel = document.getElementById('seat-selection-total');
    const providerTotalLabel = document.getElementById('checkout-provider-total');
    const submitButton = document.getElementById('seat-selection-submit');
    const chipsList = document.getElementById('seat-selection-chips');
    const clearButton = document.getElementById('seat-selection-clear');
    const seatViewport = seatForm.querySelector('[data-seat-viewport]');
    const seatCanvas = seatForm.querySelector('[data-seat-canvas]');
    const maxSeats = Number.parseInt(seatForm.dataset.maxSeats || '2', 10) || 2;
    const unitPriceCents = Number.parseInt(seatForm.dataset.unitPriceCents || '0', 10) || 0;
    const formatMoney = (cents) => `MXN ${(cents / 100).toLocaleString('es-MX')}`;

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
        countLabel.textContent = selected.length
          ? `${selected.length} de ${maxSeats} lugares elegidos`
          : 'Elige tu lugar';
      }
      if (summaryLabel) {
        summaryLabel.textContent = labels.length
          ? `Lugares elegidos: ${labels.join(', ')}. Revisa tus datos y continúa al pago.`
          : `Primero toca los tapetes disponibles en el mapa. Puedes elegir hasta ${maxSeats} lugares.`;
      }
      if (chipsList) {
        chipsList.replaceChildren();
        if (!labels.length) {
          const empty = document.createElement('span');
          empty.className = 'is-empty';
          empty.textContent = 'Sin lugares seleccionados';
          chipsList.appendChild(empty);
        } else {
          labels.forEach((label) => {
            const chip = document.createElement('span');
            chip.textContent = label;
            chipsList.appendChild(chip);
          });
        }
      }
      if (totalLabel) {
        totalLabel.textContent = selected.length ? formatMoney(unitPriceCents * selected.length) : formatMoney(0);
      }
      if (providerTotalLabel) {
        providerTotalLabel.textContent = selected.length ? formatMoney(unitPriceCents * selected.length) : formatMoney(0);
      }
      if (submitButton) {
        submitButton.disabled = selected.length === 0;
        submitButton.textContent = selected.length === 0
          ? 'Elige un lugar para continuar'
          : selected.length === 1
          ? 'Continuar al pago'
          : `Continuar con ${selected.length} lugares`;
      }
      if (clearButton) {
        clearButton.disabled = selected.length === 0;
      }
    };

    seatInputs.forEach((input) => {
      input.addEventListener('change', () => {
        const selected = seatInputs.filter((item) => item.checked);
        if (selected.length > maxSeats) {
          input.checked = false;
          if (summaryLabel) {
            summaryLabel.textContent = `Puedes elegir máximo ${maxSeats} lugares por reservación.`;
          }
        }
        updateSeatSummary();
      });
    });

    if (clearButton) {
      clearButton.addEventListener('click', () => {
        seatInputs.forEach((input) => {
          input.checked = false;
        });
        updateSeatSummary();
      });
    }

    if (seatViewport && seatCanvas) {
      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
      const isSeatTarget = (target) => target instanceof Element && Boolean(target.closest('[data-seat-option]'));
      const seatMap = seatCanvas.querySelector('.seat-map');
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

      const getInlineNumber = (element, property) => {
        if (!element) return 0;
        const rawValue = element.style?.[property];
        const numeric = Number.parseFloat(rawValue || '0');
        return Number.isFinite(numeric) ? numeric : 0;
      };

      const getContentBounds = () => {
        if (!seatMap) {
          return {
            minX: 0,
            minY: 0,
            maxX: seatCanvas.offsetWidth,
            maxY: seatCanvas.offsetHeight,
          };
        }

        const bounds = {
          minX: Number.POSITIVE_INFINITY,
          minY: Number.POSITIVE_INFINITY,
          maxX: Number.NEGATIVE_INFINITY,
          maxY: Number.NEGATIVE_INFINITY,
        };

        const includeBounds = (minX, minY, maxX, maxY) => {
          bounds.minX = Math.min(bounds.minX, minX);
          bounds.minY = Math.min(bounds.minY, minY);
          bounds.maxX = Math.max(bounds.maxX, maxX);
          bounds.maxY = Math.max(bounds.maxY, maxY);
        };

        const background = seatMap.querySelector('.seat-map-background');
        if (background) {
          const left = getInlineNumber(background, 'left');
          const top = getInlineNumber(background, 'top');
          includeBounds(left, top, left + background.offsetWidth, top + background.offsetHeight);
        }

        const instructor = seatMap.querySelector('.seat-instructor-marker');
        if (instructor) {
          const centerX = getInlineNumber(instructor, 'left');
          const centerY = getInlineNumber(instructor, 'top');
          includeBounds(
            centerX - instructor.offsetWidth / 2,
            centerY - instructor.offsetHeight / 2,
            centerX + instructor.offsetWidth / 2,
            centerY + instructor.offsetHeight / 2,
          );
        }

        seatMap.querySelectorAll('.seat-node').forEach((node) => {
          const centerX = getInlineNumber(node, 'left');
          const centerY = getInlineNumber(node, 'top');
          includeBounds(
            centerX - node.offsetWidth / 2,
            centerY - node.offsetHeight / 2,
            centerX + node.offsetWidth / 2,
            centerY + node.offsetHeight / 2,
          );
        });

        if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)) {
          return {
            minX: 0,
            minY: 0,
            maxX: seatCanvas.offsetWidth,
            maxY: seatCanvas.offsetHeight,
          };
        }

        return {
          minX: clamp(bounds.minX, 0, seatCanvas.offsetWidth),
          minY: clamp(bounds.minY, 0, seatCanvas.offsetHeight),
          maxX: clamp(bounds.maxX, 0, seatCanvas.offsetWidth),
          maxY: clamp(bounds.maxY, 0, seatCanvas.offsetHeight),
        };
      };

      const fitCanvas = () => {
        const bounds = getContentBounds();
        const padding = Math.max(24, Math.min(seatViewport.clientWidth, seatViewport.clientHeight) * 0.06);
        const safeWidth = Math.max(1, bounds.maxX - bounds.minX);
        const safeHeight = Math.max(1, bounds.maxY - bounds.minY);
        const widthScale = Math.max(0.1, (seatViewport.clientWidth - padding * 2) / safeWidth);
        const heightScale = Math.max(0.1, (seatViewport.clientHeight - padding * 2) / safeHeight);
        minScale = Math.min(widthScale, heightScale);
        maxScale = Math.max(minScale * 2.8, minScale + 1, 1.8);
        scale = minScale;
        x = (seatViewport.clientWidth - safeWidth * scale) / 2 - bounds.minX * scale;
        y = (seatViewport.clientHeight - safeHeight * scale) / 2 - bounds.minY * scale;
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

  const previewModal = document.getElementById('class-preview-modal');
  if (previewModal) {
    const frame = previewModal.querySelector('[data-class-preview-frame]');
    const openPreview = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (frame && !frame.getAttribute('src')) frame.setAttribute('src', frame.dataset.src || '');
      if (typeof previewModal.showModal === 'function') previewModal.showModal();
      else previewModal.setAttribute('open', '');
    };
    const closePreview = () => {
      if (typeof previewModal.close === 'function') previewModal.close();
      else previewModal.removeAttribute('open');
      if (frame) frame.setAttribute('src', '');
    };

    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-class-preview-video]')) openPreview(event);
    });
    document.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-class-preview-video]')) {
        openPreview(event);
      }
    });

    previewModal.querySelectorAll('[data-class-preview-close]').forEach((button) => {
      button.addEventListener('click', closePreview);
    });
    previewModal.addEventListener('click', (event) => {
      if (event.target === previewModal) closePreview();
    });
    previewModal.addEventListener('cancel', () => {
      if (frame) frame.setAttribute('src', '');
    });
  }

  document.querySelectorAll('[data-support-chat-form]').forEach((form) => {
    const log = form.querySelector('[data-support-chat-log]');
    const textarea = form.querySelector('textarea[name="message"]');
    const button = form.querySelector('button[type="submit"]');
    const appendMessage = (who, text) => {
      if (!log) return;
      const item = document.createElement('p');
      const strong = document.createElement('strong');
      const span = document.createElement('span');
      strong.textContent = who;
      span.textContent = text;
      item.append(strong, span);
      log.appendChild(item);
      log.scrollTop = log.scrollHeight;
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = textarea?.value.trim();
      if (!message) return;
      appendMessage('Tú', message);
      if (textarea) textarea.value = '';
      if (button) {
        button.disabled = true;
        button.textContent = 'Respondiendo...';
      }

      try {
        const response = await fetch('/api/support/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        const data = await response.json();
        appendMessage('Asistente', data.reply || data.error || 'No pude responder en este momento.');
      } catch {
        appendMessage('Asistente', 'No pude conectar con el asistente. Revisa tu referencia y contacta al equipo del estudio.');
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = 'Preguntar';
        }
      }
    });
  });

  const layoutPayload = document.getElementById('layout-editor-payload');
  if (layoutPayload && window.Konva) {
    const stageContainer = document.getElementById('layout-editor-stage');
    const jsonField = document.getElementById('layout-editor-json');
    if (stageContainer && jsonField) {
      const payload = JSON.parse(layoutPayload.textContent || '{}');
      const baseLayout = payload.baseLayout ? JSON.parse(JSON.stringify(payload.baseLayout)) : null;
      const matMarkAsset = payload.matMarkAsset || '/static/tisa-header-lockup.png';
      const layoutTheme = {
        caliza: themeColor('--caliza', '#F1EFE9'),
        yeso: themeColor('--yeso', '#DBD6C9'),
        arenaProfunda: themeColor('--arena-profunda', '#B3AB9B'),
        arcilla: themeColor('--arcilla', '#94674B'),
        tierraTostada: themeColor('--tierra-tostada', '#553E2B'),
        pizarra: themeColor('--pizarra', '#3C3935'),
        olivaMineral: themeColor('--oliva-mineral', '#7C7651'),
        bosqueSeco: themeColor('--bosque-seco', '#424130'),
        brumaAzul: themeColor('--bruma-azul', '#7C868D'),
      };
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
        zoomFit: document.querySelector('[data-layout-action="zoom-fit"]'),
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
      const canvasWrap = stageViewport?.parentElement || null;

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

      const fitViewportToCanvas = () => {
        if (!canvasWrap) {
          setViewportScale(1);
          return;
        }
        const availableWidth = Math.max(canvasWrap.clientWidth - 32, 320);
        const availableHeight = Math.max(canvasWrap.clientHeight - 32, 260);
        const fitScale = Math.min(1, availableWidth / stage.width(), availableHeight / stage.height());
        setViewportScale(fitScale);
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

      const getLayoutBounds = () => {
        const bounds = {
          minX: state.layout.instructor.x - 76,
          maxX: state.layout.instructor.x + 76,
          minY: state.layout.instructor.y - 26,
          maxY: state.layout.instructor.y + 26,
        };

        state.layout.seats.forEach((seat) => {
          bounds.minX = Math.min(bounds.minX, seat.x - seatHalfWidth);
          bounds.maxX = Math.max(bounds.maxX, seat.x + seatHalfWidth);
          bounds.minY = Math.min(bounds.minY, seat.y - seatHalfHeight);
          bounds.maxY = Math.max(bounds.maxY, seat.y + seatHalfHeight);
        });

        if (state.layout.background) {
          const width = state.layout.background.assetWidth * state.layout.background.scale;
          const height = state.layout.background.assetHeight * state.layout.background.scale;
          bounds.minX = Math.min(bounds.minX, state.layout.background.x);
          bounds.maxX = Math.max(bounds.maxX, state.layout.background.x + width);
          bounds.minY = Math.min(bounds.minY, state.layout.background.y);
          bounds.maxY = Math.max(bounds.maxY, state.layout.background.y + height);
        }

        return bounds;
      };

      const ensureCanvasFitsLayout = () => {
        const grid = gridSize();
        const padding = grid * 2;
        const bounds = getLayoutBounds();
        const shiftX = bounds.minX < padding ? snap(padding - bounds.minX) : 0;
        const shiftY = bounds.minY < padding ? snap(padding - bounds.minY) : 0;

        if (shiftX || shiftY) {
          state.layout.instructor.x += shiftX;
          state.layout.instructor.y += shiftY;
          state.layout.seats = state.layout.seats.map((seat) => ({
            ...seat,
            x: seat.x + shiftX,
            y: seat.y + shiftY,
          }));
          if (state.layout.background) {
            state.layout.background = {
              ...state.layout.background,
              x: state.layout.background.x + shiftX,
              y: state.layout.background.y + shiftY,
            };
          }
        }

        const nextBounds = getLayoutBounds();
        const nextWidth = Math.max(Number(state.layout.canvas?.width || 1200), snap(nextBounds.maxX + padding));
        const nextHeight = Math.max(Number(state.layout.canvas?.height || 800), snap(nextBounds.maxY + padding));
        state.layout.canvas = {
          width: nextWidth,
          height: nextHeight,
          grid,
        };
        stage.width(nextWidth);
        stage.height(nextHeight);
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

      const deleteSeatById = (seatId) => {
        if (state.locked || !seatId) return;
        const seatExists = state.layout.seats.some((seat) => seat.id === seatId);
        if (!seatExists) return;
        state.layout.seats = state.layout.seats.filter((seat) => seat.id !== seatId);
        if (state.selection.type === 'seat' && state.selection.id === seatId) {
          state.selection = { type: 'instructor', id: null };
        }
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
              fill: 'rgba(219, 214, 201, 0.42)',
            }));
          }

          if (isBackgroundSelection()) {
            backgroundGroup.add(new window.Konva.Rect({
              x: -6,
              y: -6,
              width: width + 12,
              height: height + 12,
              stroke: layoutTheme.brumaAzul,
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
          fill: state.selection.type === 'instructor' ? layoutTheme.arcilla : layoutTheme.caliza,
          stroke: layoutTheme.tierraTostada,
          strokeWidth: 2,
        }));
        instructorGroup.add(new window.Konva.Text({
          x: -66,
          y: -10,
          width: 132,
          align: 'center',
          text: state.layout.instructor.label || 'Instructora',
          fill: state.selection.type === 'instructor' ? layoutTheme.caliza : layoutTheme.pizarra,
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
          const fill = !seat.enabled || seat.bookable === false ? layoutTheme.arenaProfunda : isSelected ? layoutTheme.arcilla : layoutTheme.caliza;
          const textFill = !seat.enabled || seat.bookable === false ? layoutTheme.bosqueSeco : isSelected ? layoutTheme.caliza : layoutTheme.pizarra;
          const markImage = loadImage(matMarkAsset);

          seatGroup.add(new window.Konva.Rect({
            x: -seatHalfWidth,
            y: -seatHalfHeight,
            width: seatWidth,
            height: seatHeight,
            cornerRadius: 24,
            fill,
            stroke: seat.zone === 'near' ? layoutTheme.arcilla : seat.zone === 'back' ? layoutTheme.bosqueSeco : layoutTheme.olivaMineral,
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

          if (!state.locked) {
            const deleteButton = new window.Konva.Group({
              x: seatHalfWidth - 14,
              y: -seatHalfHeight + 14,
            });
            deleteButton.add(new window.Konva.Circle({
              radius: 11,
              fill: layoutTheme.caliza,
              stroke: layoutTheme.tierraTostada,
              strokeWidth: 2,
              shadowColor: 'rgba(60, 57, 53, 0.18)',
              shadowBlur: 8,
              shadowOffsetY: 2,
            }));
            deleteButton.add(new window.Konva.Text({
              x: -5,
              y: -7,
              width: 10,
              align: 'center',
              text: '×',
              fill: layoutTheme.tierraTostada,
              fontStyle: 'bold',
              fontSize: 14,
              listening: false,
            }));
            deleteButton.on('click tap mousedown touchstart', (event) => {
              event.cancelBubble = true;
              deleteSeatById(seat.id);
            });
            seatGroup.add(deleteButton);
          }

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
      actionButtons.zoomFit?.addEventListener('click', fitViewportToCanvas);
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
        deleteSeatById(state.selection.id);
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
        ensureCanvasFitsLayout();
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

      ensureCanvasFitsLayout();
      syncJson();
      fitViewportToCanvas();
      syncCanvasFields();
      drawGrid();
      drawLayout();
      syncInspector();
      window.addEventListener('resize', () => {
        syncViewport();
        drawGrid();
      });
    }
  }

  const trainerModal = document.getElementById('trainer-class-modal');
  const trainerTitle = document.getElementById('trainer-modal-title');
  const trainerMeta = document.getElementById('trainer-modal-meta');
  const trainerStatus = document.getElementById('trainer-modal-status');
  const trainerCancelForm = document.getElementById('trainer-cancel-form');
  const trainerCancelBtn = document.getElementById('trainer-cancel-btn');

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('.trainer-chip');
    if (!btn || !trainerModal || !trainerTitle || !trainerMeta || !trainerStatus || !trainerCancelForm || !trainerCancelBtn) return;
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

  document.querySelectorAll('[data-close-trainer-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (trainerModal && typeof trainerModal.close === 'function') trainerModal.close();
    });
  });
})();
