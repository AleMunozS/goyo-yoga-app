export const brand = {
  name: 'TISA',
  descriptor: 'Calma como sistema',
  descriptorLong: 'Espacio de regulación corporal',
  metaDescription:
    'TISA es un espacio de regulación corporal: agenda clara, reserva contenida y acceso confiable para volver al cuerpo con calma.',
  assets: {
    headerLogo: '/static/tisa-header-lockup.png',
    landingSideEmblem: '/static/tisa-side-emblem.png',
    matMark: '/static/tisa-mat-mark.svg',
    editorialGrid: '/static/tisa-editorial-grid.jpg',
    conceptGrid: '/static/tisa-concept-grid.jpg',
    mineralSurface: '/static/tisa-mineral-surface.jpg',
  },
  home: {
    kicker: 'TISA · REGULACIÓN CORPORAL · RESERVA',
    title: 'Un espacio para volver al cuerpo y reservar con claridad.',
    lede:
      'Consulta la agenda, elige tu lugar y confirma tu acceso en una experiencia pensada para sentirse serena, útil y precisa.',
    noteTitle: 'La forma también sostiene',
    noteText:
      'Cada superficie prioriza respiración visual, lectura pausada y decisiones simples. Nada acelera, nada estorba.',
    storyKicker: 'La experiencia TISA',
    storyTitle: 'La calma no se promete. Se demuestra en cómo te acompaña la interfaz.',
    storyBody:
      'La app deja de hablar como una marca aspiracional y empieza a comportarse como TISA: contiene, orienta y cuida el recorrido completo, desde la agenda hasta el QR.',
    storyQuote: 'Una experiencia sobria, táctil y clara para elegir sin ruido.',
    principles: [
      {
        label: 'Sostén',
        title: 'La interfaz acompaña; no empuja.',
        text: 'El recorrido reduce presión y deja visibles solo las decisiones que importan en cada momento.',
      },
      {
        label: 'Intención',
        title: 'Cada bloque tiene una razón clara.',
        text: 'Jerarquías suaves, más espacio en blanco y mensajes concretos para no romper la atmósfera.',
      },
      {
        label: 'Calidad',
        title: 'Menos ruido, más confianza.',
        text: 'Agenda, pago y acceso comparten una misma lógica visual para sentirse consistentes de principio a fin.',
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
    kicker: 'TISA · AGENDA · DISPONIBILIDAD REAL',
    title: 'Agenda viva para elegir con calma.',
    lede:
      'Revisa semana o mes, detecta disponibilidad real y abre la reserva desde el mismo bloque de clase, sin perder contexto.',
    howItWorksTitle: 'Cómo funciona',
    howItWorksText:
      'Toca el bloque que mejor acompaña tu ritmo, elige tus lugares y continúa al pago dentro del mismo recorrido.',
    benefitTitle: 'Lectura clara',
    benefitText: 'Disponibilidad, guía, horario y acceso al mapa de lugares viven en una sola vista.',
  },
  seatSelection: {
    kicker: 'TISA / LUGARES',
    title: 'Elige tu lugar y confirma solo cuando se sienta correcto.',
    lede:
      'Selecciona uno o dos lugares, deja tus datos y continúa al pago dentro del mismo recorrido, con una lectura clara del espacio.',
    note: 'Tu apartado se sostiene por 10 minutos mientras completas el pago.',
    summaryEmpty: 'Elige uno o dos lugares para continuar con calma.',
    cta: 'Continuar al pago',
  },
  manage: {
    kicker: 'TISA / RESERVA',
    title: 'Tu reserva queda visible hasta el momento de entrar.',
    lede: 'Consulta el estado, revisa tus lugares y presenta el QR cuando el pago ya esté confirmado.',
  },
  staff: {
    kicker: 'TISA / STAFF',
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
