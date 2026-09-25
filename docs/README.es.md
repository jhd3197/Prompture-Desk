<p align="center">
  <img src="../branding/prompture-desk-logo.png" width="96" alt="Logo de Prompture Desk" />
  <h1 align="center">Prompture Desk</h1>
  <p align="center">Lo que gastan tus apps de <a href="https://github.com/jhd3197/prompture">Prompture</a>, en la bandeja del sistema: uso por proveedor y proyecto, límites de tasa y saldos — además de llamadas en vivo, alertas y controles con <a href="https://github.com/jhd3197/prompture-hub">prompture-hub</a>.</p>
</p>

<div align="center">

[English](../README.md) | Español | [中文版](README.zh-CN.md)

![Windows](https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)

[![GitHub Stars](https://img.shields.io/github/stars/jhd3197/Prompture-Desk?style=flat-square&color=f5c542)](https://github.com/jhd3197/Prompture-Desk/stargazers)
[![Downloads](https://img.shields.io/github/downloads/jhd3197/Prompture-Desk/total?style=flat-square)](https://github.com/jhd3197/Prompture-Desk/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](../LICENSE)
[![Version](https://img.shields.io/github/v/release/jhd3197/Prompture-Desk?style=flat-square&color=8b7ff6&label=version)](https://github.com/jhd3197/Prompture-Desk/releases)
[![Tauri](https://img.shields.io/badge/tauri-2-24C8D8.svg?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/rust-1.88+-DEA584.svg?style=flat-square&logo=rust&logoColor=black)](https://rust-lang.org)
[![React](https://img.shields.io/badge/react-18-61DAFB.svg?style=flat-square&logo=react&logoColor=black)](https://reactjs.org)

</div>

<p align="center">
  <img src="screenshots/capsule.png" width="380" alt="Cápsula superior desplegada: franjas por proveedor y el uso de hoy" />
  <img src="screenshots/dock.png" width="250" alt="Barra lateral con la tarjeta de un proveedor abierta" />
</p>

Prompture Desk es una pequeña app de escritorio multiplataforma (Tauri 2: Windows, macOS, Linux).
Funciona en dos modos con una misma API:

| | **Prompture en este PC** (sin configurar nada) | **prompture-hub** (mejora opcional) |
|---|---|---|
| Necesita | Nada — Desk usa tu Prompture o instala el suyo | Un prompture-hub en marcha, vinculado una vez |
| Ve | Cada llamada que hacen tus scripts y apps de Prompture en esta máquina, más tus herramientas de código (Claude Code, Codex, Kimi Code, …) | Cada llamada que pasa por el hub — herramientas de código incluidas — desde cualquier máquina |
| Muestra | Uso por proveedor y proyecto, margen de límites de tasa, uso y límites de plan de las herramientas de código, saldos de proveedores, llamadas al terminar | Todo lo anterior, más llamadas mientras se ejecutan, topes por clave y reglas de alerta |
| Controla | Presupuestos y alertas dentro de Desk | Pausar claves y proveedores, redirigir rutas, confirmar alertas |

En modo local, Desk inicia `prompture companion` por ti (un pequeño servidor solo para localhost
que viene con Prompture) y lo detiene al cerrarse. Usa el Prompture que instalaste si ya trae el
companion (1.13+). Si no — sin Python, sin Prompture o con una versión antigua — Desk instala su
propia copia con el [uv](https://github.com/astral-sh/uv) incluido: su propio Python y su propio
Prompture, guardados en la carpeta de datos de Desk, sin tocar los tuyos, y actualizados una vez al
día (en Ajustes › Acerca de puedes hacer que pregunte antes, o desactivarlo). Tarda como un minuto,
una sola vez. Asigna el gasto a proyectos con `PROMPTURE_PROJECT=nombre` o
`get_tracker().project("nombre")` en tu código.

El companion también cuenta tus **herramientas de código** a partir de los logs que guardan en este
PC — Claude Code, Codex, Kimi Code, Gemini CLI, Qwen Code, OpenCode, Cline, Roo Code y Continue
(Cursor y Antigravity se detectan, pero guardan el uso en sus cuentas en línea). **Desk ›
Herramientas de código** muestra las llamadas, tokens, modelos y proyectos de cada una para hoy, la
semana o el mes, qué herramientas están instaladas y cuáles puede ejecutar también Prompture. Solo
se leen conteos de tokens, nombres de modelos, horas y nombres de carpetas, nunca prompts ni
respuestas. Los costos son lo que costarían esos mismos tokens en la API — las suscripciones no
cobran por token, así que para ellas **tokens** suele ser mejor métrica.

Los límites de plan aparecen en **Límites › Planes de código**. Los de Codex salen de sus propios
logs. Claude Code no escribe en disco sus ventanas de 5 horas y semanal; Prompture puede leerlas
igual que Claude Code, con el propio inicio de sesión de Claude Code, pero solo si lo activas con
`PROMPTURE_CLAUDE_PLAN_USAGE=1`. Para no leer ninguna herramienta de código, ejecuta el companion
con `--no-coding-tools`.

## Automatizaciones

**Desk › Automatizaciones** pone en cola pasos para un agente de código que se ejecutan uno tras
otro, como jugadas preparadas: elige la carpeta de un proyecto y un agente (Claude Code o Codex),
escribe los pasos (**Desde el roadmap** añade un `/gsd:execute-phase N` por cada fase sin marcar en
`.planning/ROADMAP.md`) y pulsa **Ejecutar**. Cada paso empieza en cuanto termina el anterior,
continuando su sesión o empezando una nueva. Los pasos que aún no han empezado se pueden añadir,
quitar y reordenar mientras la cola corre.

La cola se pausa sola cuando un paso falla, cuando el agente termina con una pregunta (respóndela
desde Desk y la sesión de ese paso continúa), cuando la ventana del plan del agente está casi
agotada (sigue cuando se reinicia) o al pasar un tope de costo que tú fijas. La cápsula muestra el
progreso, y Desk te avisa cuando termina un paso, cuando la cola te necesita y cuando acaba. Los
pasos corren sin supervisión, así que se omiten las solicitudes de permiso del agente. La cola la
ejecuta el companion de Prompture, así que se detiene si cierras Desk.

## El widget

Elige un estilo en **Desk › Widget**. Los tres muestran lo mismo — el uso de hoy de cada proveedor
frente al presupuesto diario que le pongas, como una franja fina que se vuelve ámbar cerca del límite:

| Estilo | Qué es |
|---|---|
| **Cápsula superior** (por defecto) | Una isla arriba en el centro de la pantalla que cambia de forma según su estado: invitación a configurar, conectando, en vivo (total de hoy, el logo y la franja de cada proveedor), un aviso breve de "llamada terminada" e inactiva. Haz clic para desplegarla en un panel por proveedor. |
| **Barra lateral** | Una columna flotante en el borde izquierdo o derecho. Pasa el ratón por un proveedor para ver su tarjeta (presupuesto, ventana de tasa, Pausar / Reanudar). Arrástrala por el total; se pega al borde más cercano. |
| **Icono de bandeja** | Sin widget, solo el icono de la bandeja — dibujado con una barra por proveedor y un punto ámbar para alertas. (Con los otros estilos la bandeja muestra el icono de la app, en gris cuando no hay conexión.) |

**Visibilidad** decide si el widget se queda a la vista: *Mostrar al pasar el ratón* (por defecto)
esconde la cápsula en una franja en el borde superior y la barra lateral en una pestaña de barras en
su borde, y las saca cuando el puntero llega a ellas; *Siempre* las mantiene visibles.

**Desk** es una sola ventana, centrada en la pantalla: haz clic en el icono de la bandeja, doble clic
en el widget, o usa **Abrir Desk** en la cápsula. Su barra lateral tiene un pequeño panel —
**Resumen** (hoy, esta semana y este mes, proveedores frente a sus presupuestos, proyectos, llamadas
recientes), **Actividad**, **Límites** y **Alertas** — y debajo los ajustes.

El uso se puede mostrar como **precio** o **tokens** (planes de tarifa plana), y el resto está en
Ajustes: nivel de detalle, siempre encima, ocultar con apps a pantalla completa, abrir al iniciar
sesión, claro / oscuro / sistema, color de acento, opacidad del widget, presupuestos / orden /
visibilidad por proveedor, el umbral de aviso, notificaciones (alertas del hub, claves o proveedores
en pausa, llamadas largas, fallos) con sonido del sistema opcional, y la frecuencia de actualización.
Los logos de proveedores son los iconos de marca de LobeHub, incluidos sin conexión.

Con acceso de **control**, Desk puede pausar y reanudar proveedores (en todo el hub) y claves,
redirigir una clave a otro modelo o combo, y confirmar alertas.

## Primeros pasos

Instala Desk, ábrelo y elige **Usar Prompture en este PC**. Eso es todo — no hace falta Python.

Para añadir un hub más tarde: **Ajustes › Conexión › Conectar un prompture-hub**. Desk encuentra
solo un hub en `127.0.0.1:1984`, o acepta su dirección, muestra un código corto y tú lo apruebas en
el panel del hub. La vinculación usa OAuth 2.0 Device Authorization Grant (RFC 8628); el token del
dispositivo se guarda en el llavero del sistema (nunca en un archivo ni en el webview), solo puede
leer el estado del hub — y cambiar ajustes de claves y proveedores con el alcance de control — y
nunca llama a modelos. Revócalo en el panel en **Settings › Devices**.

## Desarrollo

Requisitos: Node 20+, Rust (stable, vía rustup) y los [requisitos de Tauri](https://tauri.app/start/prerequisites/)
para tu sistema.

```bash
npm install
npm run tauri dev      # descarga uv, arranca Vite en 127.0.0.1:28417 y la app
npm run tauri build    # instaladores para el sistema actual
```

> **Windows:** si `cargo --version` no coincide con `rustup run stable cargo --version`, hay otra
> instalación de Rust (p. ej. la de Chocolatey) antes que rustup en el `PATH`. Pon
> `%USERPROFILE%\.cargo\bin` primero.

Los tokens de diseño se sincronizan desde el panel del hub, y los logos de proveedores se generan
como un subconjunto sin conexión del set de iconos de LobeHub:

```bash
npm run sync-tokens    # lee ../prompture-hub/frontend/src/styles.css (o $HUB_STYLES)
npm run gen:icons      # regenera src/lib/providerIconData.ts desde @lobehub/icons-static-svg
npm run fetch:uv       # descarga el uv fijado en src-tauri/binaries/ (corre antes de dev/build)
```

Para probar la instalación propia de Prompture de Desk contra una copia local (antes de que haya
versión en PyPI), inicia Desk con `PROMPTURE_DESK_PACKAGE=/ruta/a/prompture`.

### Estructura

- `src-tauri/src/hub.rs` — cliente de la API del companion, vinculación, parser SSE (todo el tráfico pasa por Rust).
- `src-tauri/src/local.rs` — encuentra o inicia `prompture companion` (modo local) e instala el Prompture propio de Desk con uv cuando hace falta.
- `src-tauri/src/live.rs` — conexión `/v1/live` con reintentos y reanudación por `Last-Event-ID`.
- `src-tauri/src/store.rs` — archivo de ajustes + tokens en el llavero.
- `src-tauri/src/tray.rs` — dibujo del icono de bandeja (barras por proveedor) y su menú.
- `src-tauri/src/windows.rs` — la ventana de Desk y la del widget.
- `src-tauri/src/platform.rs` — detección de pantalla completa y sonido de alerta del sistema (Windows).
- `src/lib/useDesk.ts` — estado en vivo, sondeo, resumen de la bandeja y notificaciones.
- `src/lib/model.ts` — filas por proveedor (uso vs presupuesto, ventana de tasa, en curso, en pausa).
- `src/desk.tsx` — la ventana de Desk (panel + ajustes); `src/widget.tsx` — barra lateral y cápsula superior.
- `src/views/Settings.tsx` — las páginas de ajustes.
- `src/views/` — bienvenida, Now / Headroom / Alerts.

Habla la versión 1 de la API del companion (`GET /v1/companion/info`), servida por
`prompture companion` (Prompture 1.13+) y por prompture-hub.

## Licencia

MIT
