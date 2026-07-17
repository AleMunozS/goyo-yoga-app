export const brand = {
  name: 'TISA',
  descriptor: 'Movimiento que regula',
  descriptorLong: 'Yoga, inmersión y descanso corporal',
  metaDescription:
    'TISA es un espacio de regulación corporal: agenda clara, reserva contenida y acceso confiable para volver al cuerpo con calma.',
  assets: {
    headerLogo: '/static/tisa-header-lockup.png',
    favicon: '/static/tisa-header-lockup.png',
    landingSideEmblem: '/static/tisa-side-emblem.png',
    matMark: '/static/tisa-header-lockup.png',
    editorialGrid: '/static/tisa-editorial-grid.jpg',
    conceptGrid: '/static/tisa-concept-grid.jpg',
    mineralSurface: '/static/tisa-mineral-surface.jpg',
  },
  home: {
    kicker: 'YOGA · YOGA INMERSIVO · HEAD SPA',
    title: 'Tu cuerpo no necesita más ruido.',
    lede:
      'Movimiento, estímulo sensorial y descanso profundo se reúnen en prácticas diseñadas para devolverte presencia.',
    noteTitle: 'Hoy puedes llegar como estás',
    noteText:
      'Elige la intensidad que tu cuerpo pide. Nosotros sostenemos el resto del recorrido.',
    storyKicker: 'NO ES ESCAPAR. ES REGRESAR.',
    storyTitle: 'Tres maneras de volver a sentirte presente.',
    storyBody:
      'Yoga para aterrizar. Inmersión para activar. Head Spa para soltar. Cada experiencia parte de una necesidad corporal distinta y termina en el mismo lugar: más cerca de ti.',
    storyQuote: 'No vienes a rendir. Vienes a escucharte.',
    principles: [
      {
        label: '01 / ATERRIZA',
        title: 'Respira antes de decidir.',
        text: 'Horarios, intensidad y lugares disponibles se leen sin prisa y sin información de más.',
      },
      {
        label: '02 / ELIGE',
        title: 'Encuentra tu ritmo de hoy.',
        text: 'Compara prácticas desde lo que necesitas sentir, no desde una promesa abstracta.',
      },
      {
        label: '03 / LLEGA',
        title: 'Tu lugar ya te espera.',
        text: 'Reserva tu tapete exacto y conserva el acceso en un recorrido claro hasta la entrada.',
      },
    ],
    journey: [
      {
        step: '01',
        title: 'Explora la agenda',
        text: 'Lee semana o mes con claridad y detecta rápido la práctica que mejor acompaña tu ritmo.',
      },
      {
        step: '02',
        title: 'Elige tu lugar',
        text: 'Selecciona uno o dos lugares exactos, deja tus datos y conserva el apartado mientras completas el pago.',
      },
      {
        step: '03',
        title: 'Llega con certeza',
        text: 'Cuando el pago queda confirmado, el QR aparece dentro del mismo sistema y acompaña tu entrada al estudio.',
      },
    ],
  },
  agenda: {
    kicker: 'AGENDA / DISPONIBILIDAD EN TIEMPO REAL',
    title: 'Encuentra el ritmo que hoy sí te cabe.',
    lede:
      'Explora por día, intensidad y horario. Cuando una práctica haga sentido, elige tu lugar exacto dentro de la sala.',
    howItWorksTitle: 'Cómo funciona',
    howItWorksText:
      'Toca el bloque que mejor acompaña tu ritmo, elige tus lugares y continúa al pago dentro del mismo recorrido.',
    benefitTitle: 'Lectura clara',
    benefitText: 'Disponibilidad, guía, horario y acceso al mapa de lugares viven en una sola vista.',
  },
  seatSelection: {
    kicker: 'RESERVA / MAPA DE SALA',
    title: 'Tu lugar en la sala, sin adivinar.',
    lede:
      'Selecciona uno o dos lugares, deja tus datos y continúa al pago dentro del mismo recorrido, con una lectura clara del espacio.',
    note: 'Tu apartado se sostiene por 10 minutos mientras completas el pago.',
    summaryEmpty: 'Elige uno o dos lugares para continuar con calma.',
    cta: 'Continuar al pago',
  },
  manage: {
    kicker: 'RESERVA',
    title: 'Tu reserva queda visible hasta el momento de entrar.',
    lede: 'Consulta el estado, revisa tus lugares y presenta el QR cuando el pago ya esté confirmado.',
  },
  staff: {
    kicker: 'STAFF',
    title: 'La operación también debe sentirse clara y contenida.',
    lede:
      'Administración, trainers y check-in comparten el mismo lenguaje visual para operar con precisión, sin fricción ni exceso.',
  },
};

export function getCheckoutStateCopy(state) {
  if (state === 'paid') {
    return {
      title: 'Pago confirmado. Tu acceso ya está listo.',
      copy: 'Tu lugar quedó asegurado y el QR ya está disponible para cuando llegues al estudio.',
    };
  }

  if (state === 'pending_async') {
    return {
      title: 'Estamos terminando de validar tu pago.',
      copy: 'Tu apartado sigue activo mientras se confirma el resultado final. No necesitas empezar de nuevo.',
    };
  }

  if (state === 'expired' || state === 'expired_after_payment') {
    return {
      title: 'El apartado ya se liberó.',
      copy: 'Si el pago llegó fuera de tiempo, el equipo debe revisarlo manualmente para evitar inconsistencias.',
    };
  }

  if (state === 'failed') {
    return {
      title: 'El pago no se completó.',
      copy: 'Liberamos los lugares para cuidar la disponibilidad real. Puedes volver a reservar cuando quieras.',
    };
  }

  return {
    title: 'Estamos revisando tu pago.',
    copy: 'Tu reservación se actualizará en cuanto Stripe confirme el resultado final.',
  };
}
