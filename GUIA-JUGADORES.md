# Forever AI Companion: cómo instalarlo

Pregúntale a una IA lo que quieras sobre tu personaje sin salir de **World of Warcraft: Forever**. Por ejemplo: *"¿Qué mazmorra me conviene hacer ahora?"*. La IA ya sabe tu clase, nivel, equipo, dónde estás y qué misiones tienes, y te responde dentro del juego.

Solo funciona en **Windows 10 u 11**. Configurarlo toma unos 3 minutos y se hace una sola vez.

## 1. Descarga y abre la app

1. Descarga **ForeverAICompanion.exe**.
2. Haz doble clic en el archivo.

> **¿Aparece "Windows protegió su PC"?** Es normal en programas nuevos que todavía no tienen firma digital. Pulsa **Más información** y luego **Ejecutar de todas formas**.

La app se instala sola: crea un acceso directo **Forever AI Companion** en el escritorio y en el menú Inicio y abre su ventana. Puedes borrar el archivo que descargaste.

## 2. Sigue el asistente

La ventana te guía paso a paso. A la izquierda ves en qué paso estás; abajo, el botón para continuar.

| Paso | Qué hacer |
|---|---|
| **Tu juego** | Normalmente encuentra WoW Forever solo: si la carpeta es correcta, pulsa **Siguiente**. Si no lo encuentra, pulsa **Elegir carpeta…** y elige la carpeta *World of Warcraft*. |
| **El addon** | Pulsa **Instalar el addon**. Si WoW estaba abierto, ciérralo por completo y vuelve a abrirlo. |
| **Tu IA** | Elige quién responde. Si tienes **Claude Pro o Max**, usa *Mi suscripción de Claude*; si tienes **ChatGPT Plus o Pro**, usa *Mi suscripción de ChatGPT*. No pagas nada extra. La app te pide instalar el programa oficial (Claude Code o Codex) e iniciar sesión, con un botón para cada cosa. Si prefieres otra IA, la ventana explica cómo conseguir la clave. Al final pulsa **Guardar y probar**: verás una respuesta de ejemplo. |
| **Envío invisible** (opcional) | Elige cómo llega tu pregunta del juego a la app (abajo se explica cada opción). |
| **Listo** | Deja activado **Abrir al iniciar Windows** para no tener que acordarte de abrir la app. |

### ¿Invisible o con línea en pantalla?

Por seguridad, WoW no deja que los addons se comuniquen con otros programas de tu PC: no pueden usar internet ni escribir archivos mientras juegas. Por eso tu pregunta necesita un camino para salir del juego y llegar a la app, que es la que habla con la IA. Hay dos caminos y **las respuestas vuelven igual con los dos**.

> **Te recomendamos el envío invisible:** es el único que no interfiere con nada mientras juegas. No aparece nada en la pantalla, no se escucha nada y funciona aunque WoW esté minimizado o detrás de otra ventana. Solo pide un permiso de Windows una vez.

**Invisible (recomendado)**
- **Cómo funciona:** se agrega a Windows una voz más, como las del Narrador, pero completamente muda. Al preguntar, el addon "lee" tu pregunta con esa voz y, en lugar de sonar, la voz se la entrega a la app. No ves ni escuchas nada.
- **Qué se instala:** una voz silenciosa llamada "ForeverAICompanion" en la lista de voces de Windows. No cambia tus otras voces ni el sonido del PC.
- **Por qué pide permiso de administrador:** Windows solo permite agregar voces con ese permiso. Te lo pide una sola vez; pulsa **Sí**. Si dices que no, no se instala nada.
- **Después:** cierra WoW por completo y vuelve a abrirlo. Puedes desactivarlo cuando quieras desde el panel de la app.

**Con una línea en pantalla**
- **Cómo funciona:** al preguntar, el addon dibuja durante un instante una línea delgada de cuadritos oscuros en el borde superior de la pantalla. La app la lee, como si fuera un código QR, y la línea desaparece.
- **Qué se instala:** nada extra, y no pide permisos.
- **Ten en cuenta:** verás un parpadeo breve arriba de la pantalla cada vez que preguntas, y WoW tiene que estar visible (no minimizado ni tapado por otra ventana) en ese momento.

Los dos caminos usan funciones normales de Windows y del juego: no modifican WoW ni leen su memoria.

## 3. Juega

1. **Abre WoW Forever** (si ya estaba abierto, ciérralo por completo y vuelve a abrirlo).
2. **Pulsa el botón flotante:** es un círculo con el retrato de tu asistente, arriba a la derecha de la pantalla, junto al minimapa. Puedes arrastrarlo a donde te quede más cómodo.
3. **La primera vez, elige a tu asistente:** **Fizzi**, la inventora gnoma (Alianza), o **Rizzik**, el negociante goblin (Horda).
4. **Escribe tu pregunta** y pulsa Enviar. En unos segundos aparece la respuesta, y si tenías la ventana cerrada te llega un aviso.

Cada chat recuerda su conversación: usa uno por tema (equipo, misiones, mazmorras…). Con clic derecho en el botón flotante abres un chat nuevo.

¿Prefieres el teclado? También puedes escribir `/ia` en el chat del juego para abrir la ventana, o `/ia` seguido de tu pregunta para preguntar directo.

## Cambiar algo después

Abre **Forever AI Companion** desde el menú Inicio. Verás el panel con todo lo que está configurado: pulsa **Cambiar** al lado de lo que quieras modificar (por ejemplo, la IA o el modelo).

## Preguntas frecuentes

**¿Cuánto cuesta?**
La app es gratis. Con tu suscripción de Claude Pro o Max, o de ChatGPT Plus o Pro, no pagas nada extra: las preguntas cuentan para el límite de uso de tu plan. Con una clave de API pagas según el uso (con Claude, entre menos de 0,1 y unos 2 centavos de dólar por pregunta). Gemini suele tener un uso gratuito limitado.

**¿La IA conoce WoW Forever?**
Forever salió en noviembre de 2026, después de que se entrenaran las IA, así que no lo conocen de memoria. Por eso la app les da una guía base de Forever (zonas, mazmorras, la raza Cielonata, cambios) y, con Claude o con tu suscripción de ChatGPT, la IA **busca en internet** cuando necesita un dato propio de Forever. Esas respuestas tardan unos segundos más (unos 15 s). Puedes desactivar la búsqueda en el panel de la app.

**No llega la respuesta.**
- Abre la app y mira que arriba diga **Funcionando**.
- Si acabas de instalar el addon, cierra WoW por completo y vuelve a abrirlo.
- Si la respuesta no aparece, escribe `/ia buzon` en el chat del juego para revisar si hay respuestas nuevas.

**No puedo preguntar en combate.**
Es a propósito: espera a salir del combate.

**No veo el botón flotante.**
Puede que lo hayas ocultado (Shift + clic derecho). Escribe `/ia boton` en el chat del juego para mostrarlo, o `/ia boton reset` para devolverlo a su lugar.

**¿Qué datos se envían?**
En la ventana del juego pulsa **Ver los datos que envío** (abajo a la izquierda). Solo se envían a la IA que elegiste.

**¿Cómo lo desinstalo?**
Abre la app y, en *Más opciones*, pulsa **Desinstalar**. Se borran el addon, tu configuración y el programa.

**¿Es seguro para mi cuenta de Battle.net?**
La app no modifica el juego, no lee su memoria y no juega por ti. Solo usa funciones normales de los addons. Aun así, no es un producto de Blizzard: úsalo bajo tu responsabilidad.
