# Server knowledge

Every `.md`, `.txt` or `.json` file in this folder is added to the AI's instructions with every question, and it takes priority over the built-in WoW Forever guide.
Files starting with `_` and this README are ignored.

Use it so the AI doesn't make up facts that depend on WoW Forever or your server. For example:

- `dungeons.md`: each dungeon's name, zone, entrance (x, y) and recommended level range.
- `zones.md`: quest zones by level range and faction.
- `notes.md`: Forever changes the model cannot know about.

Example `dungeons.md` (check every fact in the game first):

```
Name | Entrance zone (x, y) | Recommended level | Faction | Notes
Ragefire Chasm | Orgrimmar | 13-18 | Horde | Entrance inside the city
The Deadmines | Westfall (42, 72) | 17-26 | Alliance | Final boss: Edwin VanCleef
```

---

# Conocimiento del servidor

Todo archivo `.md`, `.txt` o `.json` de esta carpeta se añade a las instrucciones de la IA en cada pregunta, y tiene prioridad sobre la guía de WoW Forever incluida. Los archivos que empiezan con `_` y este README se ignoran.

Sirve para que la IA no invente datos que dependen de WoW Forever o de tu servidor. Por ejemplo: `mazmorras.md` (nombre, zona, entrada y nivel de cada mazmorra), `zonas.md` (zonas por nivel y facción) o `notas.md` (cambios propios de Forever). Puedes escribirlos en español.

Ejemplo de `mazmorras.md` (verifica cada dato en el juego antes):

```
Nombre | Zona de la entrada (x, y) | Nivel recomendado | Facción | Notas
Sima Ígnea | Orgrimmar | 13-18 | Horda | Entrada dentro de la ciudad
Minas de la Muerte | Páramos de Poniente (42, 72) | 17-26 | Alianza | Jefe final: Edwin VanCleef
```
