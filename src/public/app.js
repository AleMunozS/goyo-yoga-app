(() => {
  const revealEls = document.querySelectorAll('.reveal');
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) entry.target.classList.add('show');
    }
  }, { threshold: 0.15 });
  revealEls.forEach((el) => io.observe(el));

  const parallaxEls = document.querySelectorAll('.parallax');
  window.addEventListener('scroll', () => {
    const y = window.scrollY * 0.08;
    parallaxEls.forEach((el, i) => {
      el.style.setProperty('--parallax', `${(i + 1) * y}px`);
    });
  });
})();
