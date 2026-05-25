#!/usr/bin/env python3
"""
Organizador nocturno (2:00 AM) para TelegramDownloads/.

Funciones:
- Clasifica por extensión: películas, series, anime, libros, audiolibros, cómics.
- Usa un LLM local vía HTTP (endpoint /chat/completions con respuesta JSON) para diferenciar PELICULAS vs SERIES/ANIME y normalizar nombres de serie.
- Mueve a las carpetas destino dentro de /home/manu/servidorix.
- Convierte CBR → CBZ en COMICS y elimina el .cbr tras éxito.
Requisitos: LOCAL_LLM_BASE_URL, LOCAL_LLM_MODEL, binarios unrar y zip instalados.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
import zipfile

import requests
import re

# Raíz del NAS (se requiere BASE_DIR en entorno; sin valor se aborta)
env_base = os.getenv("BASE_DIR")
if not env_base:
    raise SystemExit("ERROR: BASE_DIR no definido. Exporta BASE_DIR (ej. /media/raid5) antes de ejecutar.")
BASE_DIR = Path(env_base)
SRC_DIR = BASE_DIR / "SRC"
DOWNLOADS_DIR = BASE_DIR / "TelegramDownloads"
DEST_DIRS = {
    "movies": BASE_DIR / "PELICULAS",
    "series": BASE_DIR / "SERIES",
    "anime": BASE_DIR / "ANIME",
    "books": BASE_DIR / "LIBROS",
    "audiobooks": BASE_DIR / "AUDIOLIBROS",
    "comics": BASE_DIR / "COMICS",
}
LOG_FILE = BASE_DIR / "organize_nightly.log"
OTHER_DIR = DOWNLOADS_DIR / "OTROS"

VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".wmv"}
BOOK_EXTS = {".epub", ".pdf"}
AUDIOBOOK_EXTS = {".mp3", ".m4a", ".m4b", ".aac"}
COMIC_EXTS = {".cbr", ".cbz"}

# --- Heurística determinista de detección de series ---------------------------
# Pre-clasificación que se aplica ANTES de llamar al LLM. Si dos o más archivos
# del lote comparten el mismo prefijo y solo difieren en un número final
# secuencial (ej: "Saga 1.mp4", "Saga 2.mp4"…), los marcamos como serie con ese
# prefijo. Resuelve el caso típico que el LLM no detecta porque no hay sufijo
# formal de episodio (S01E02, 1x05, Cap. NN…).
_RESOLUTION_RE = re.compile(r"\s*\(?\d{3,4}\s*x\s*\d{3,4}\)?\s*")
_YEAR_RE = re.compile(r"\s*\(?\b(19|20)\d{2}\b\)?\s*")
_TRAILING_NUM_RE = re.compile(r"^(.+?)[\s\-_]+(\d{1,3})\s*$")


def _strip_video_decorations(name: str) -> str:
    """Elimina año y resolución del nombre para comparar bases entre archivos."""
    name = _RESOLUTION_RE.sub(" ", name)
    name = _YEAR_RE.sub(" ", name)
    return re.sub(r"\s+", " ", name).strip()


def _extract_episode_base(filename: str) -> str | None:
    """Si el nombre acaba en "<base> <numero>" devuelve <base>. None si no aplica."""
    stem = Path(filename).stem
    cleaned = _strip_video_decorations(stem)
    match = _TRAILING_NUM_RE.match(cleaned)
    if not match:
        return None
    base = match.group(1).strip().rstrip("-_ ").strip()
    # Evita matches demasiado cortos (e.g. "v 1.mp4") que producirían falsos positivos.
    if len(base) < 3:
        return None
    return base


def detect_series_groups(files: list[Path]) -> dict[str, str]:
    """Agrupa archivos por base (sin año, resolución ni número final).

    Si 2+ archivos comparten esa base → todos son episodios de una serie con
    serie = la base original (mantiene el casing del primer archivo encontrado).
    Devuelve {filename: serie_name} para los que matchean.
    """
    groups: dict[str, list[Path]] = {}
    for f in files:
        base = _extract_episode_base(f.name)
        if not base:
            continue
        groups.setdefault(base.lower(), []).append(f)
    result: dict[str, str] = {}
    for _, members in groups.items():
        if len(members) >= 2:
            # Usar el casing del primer archivo del grupo como nombre de serie.
            series_name = _extract_episode_base(members[0].name)
            for f in members:
                result[f.name] = series_name
    return result


def log(message: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{timestamp} - {message}"
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    if sys.stdout.isatty():
        print(line)

def reset_log() -> None:
    try:
        LOG_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def ensure_directories() -> None:
    for path in DEST_DIRS.values():
        path.mkdir(parents=True, exist_ok=True)
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    OTHER_DIR.mkdir(parents=True, exist_ok=True)


def check_tools() -> None:
    missing = []
    for tool in ("unrar", "zip"):
        if shutil.which(tool) is None:
            missing.append(tool)
    if missing:
        log(f"ERROR: Faltan herramientas: {' '.join(missing)} (instalar con: sudo apt install {' '.join(missing)})")
        sys.exit(1)


def safe_move(src: Path, dst_dir: Path) -> Path | None:
    try:
        dst_dir.mkdir(parents=True, exist_ok=True)
        target = dst_dir / src.name
        if target.exists():
            stem, suffix = src.stem, src.suffix
            counter = 1
            while True:
                candidate = dst_dir / f"{stem}_{counter}{suffix}"
                if not candidate.exists():
                    target = candidate
                    break
                counter += 1
        shutil.move(str(src), str(target))
        try:
            label = dst_dir.relative_to(BASE_DIR)
        except Exception:
            label = dst_dir
        log(f"MOVIDO a {label}: {src.name} -> {target}")
        return target
    except Exception as exc:
        log(f"ERROR: No se pudo mover {src} a {dst_dir}: {exc}")
        return None


def convert_cbr_to_cbz_and_delete(cbr_path: Path) -> bool:
    temp_dir = Path(tempfile.mkdtemp(prefix="cbr2cbz_"))
    try:
        extract = subprocess.run(
            ["unrar", "x", "-o+", str(cbr_path), str(temp_dir)],
            capture_output=True,
            text=True,
            check=False,
        )
        if extract.returncode != 0:
            log(f"ERROR: Falló unrar en {cbr_path.name}: {extract.stderr.strip()}")
            return False
        if not any(temp_dir.iterdir()):
            log(f"ERROR: No se extrajeron archivos desde {cbr_path.name}")
            return False

        cbz_path = cbr_path.with_suffix(".cbz")
        zip_cmd = subprocess.run(
            ["zip", "-r", "-q", cbz_path.name, "."],
            cwd=str(temp_dir),
            capture_output=True,
            text=True,
            check=False,
        )
        if zip_cmd.returncode != 0:
            log(f"ERROR: Falló zip en {cbr_path.name}: {zip_cmd.stderr.strip()}")
            return False

        temp_cbz = temp_dir / cbz_path.name
        shutil.move(str(temp_cbz), str(cbz_path))
        cbr_path.unlink(missing_ok=True)
        log(f"CONVERTIDO: {cbr_path.name} -> {cbz_path.name} (cbr eliminado)")
        return True
    except Exception as exc:
        log(f"ERROR: Conversión CBR→CBZ fallida para {cbr_path.name}: {exc}")
        return False
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def process_zip_for_comics(zip_path: Path) -> int:
    temp_dir: Path | None = None
    try:
        with zipfile.ZipFile(zip_path) as zf:
            members = zf.namelist()
            comic_members = [m for m in members if m.lower().endswith((".cbr", ".cbz"))]
            if not comic_members:
                log(f"ADVERTENCIA: ZIP sin cómics: {zip_path.name}")
                return 0
            temp_dir = Path(tempfile.mkdtemp(prefix="zip_comics_"))
            zf.extractall(temp_dir)
            moved_count = 0
            for member in comic_members:
                src = temp_dir / member
                if not src.is_file():
                    continue
                moved = safe_move(src, DEST_DIRS["comics"])
                if moved:
                    moved_count += 1
                    # Conversión CBR→CBZ desactivada (2026-05-04): consumía minutos por archivo.
                    # if moved.suffix.lower() == ".cbr":
                    #     convert_cbr_to_cbz_and_delete(moved)
            log(f"ZIP procesado ({zip_path.name}): {moved_count} cómics extraídos")
            zip_path.unlink(missing_ok=True)
            return moved_count
    except Exception as exc:
        log(f"ERROR: Fallo al procesar ZIP {zip_path.name}: {exc}")
        return -1
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)


def process_zip_for_videos(zip_path: Path, tipo: str, serie: str) -> bool:
    temp_dir: Path | None = None
    try:
        with zipfile.ZipFile(zip_path) as zf:
            members = zf.namelist()
            video_members = [m for m in members if m.lower().endswith(tuple(VIDEO_EXTS))]
            if not video_members:
                log(f"ADVERTENCIA: ZIP sin videos: {zip_path.name}")
                return False
            temp_dir = Path(tempfile.mkdtemp(prefix="zip_video_"))
            zf.extractall(temp_dir)
            container = temp_dir / zip_path.stem
            container.mkdir(parents=True, exist_ok=True)
            for item in temp_dir.iterdir():
                if item == container:
                    continue
                shutil.move(str(item), str(container / item.name))

            if tipo == "serie":
                target_dir = DEST_DIRS["series"] / serie if serie else DEST_DIRS["series"] / "SinTitulo"
            elif tipo == "anime":
                target_dir = DEST_DIRS["anime"]
            else:
                target_dir = DEST_DIRS["movies"]

            moved = safe_move(container, target_dir)
            if moved:
                log(f"ZIP de video movido: {zip_path.name} -> {moved}")
                zip_path.unlink(missing_ok=True)
                return True
            return False
    except Exception as exc:
        log(f"ERROR: Fallo al procesar ZIP de video {zip_path.name}: {exc}")
        return False
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)


def gather_nas_context(max_items_per_list: int = 200) -> str:
    """Construye contexto sobre la estructura del NAS para enriquecer el prompt del LLM.

    Lee las subcarpetas existentes de SERIES/ y ANIME/ para que el modelo pueda emparejar
    nuevos episodios con series ya catalogadas (mismo nombre exacto de carpeta) en vez de
    inventar variantes ("La nena" vs "la_nena" vs "LA NENA"). Trunca cada lista para evitar
    inflar el prompt si hay cientos de carpetas.
    """
    def list_subdirs(path: Path) -> list[str]:
        if not path.exists():
            return []
        try:
            return sorted(p.name for p in path.iterdir() if p.is_dir() and not p.name.startswith("."))
        except Exception:
            return []

    series_existentes = list_subdirs(DEST_DIRS["series"])
    anime_existentes = list_subdirs(DEST_DIRS["anime"])

    def fmt_lista(items: list[str]) -> str:
        if not items:
            return "(ninguna catalogada todavía)"
        truncado = items[:max_items_per_list]
        sufijo = f" … (+{len(items) - max_items_per_list} más)" if len(items) > max_items_per_list else ""
        return ", ".join(f"\"{x}\"" for x in truncado) + sufijo

    return (
        "ESTRUCTURA DEL NAS (raíz: /media/raid5):\n"
        "- PELICULAS/    → películas individuales\n"
        "- SERIES/<Nombre Serie>/   → series TV, una subcarpeta por serie\n"
        "- ANIME/        → anime\n"
        "- LIBROS/       → epub, pdf\n"
        "- AUDIOLIBROS/  → m4a, m4b, mp3\n"
        "- COMICS/       → cbr, cbz\n"
        "- TelegramDownloads/  → carpeta de entrada (lo que estás clasificando)\n"
        "\n"
        "SERIES YA CATALOGADAS EN EL NAS (usa estos nombres EXACTOS si encajan):\n"
        f"{fmt_lista(series_existentes)}\n"
        "\n"
        "ANIME YA CATALOGADO EN EL NAS:\n"
        f"{fmt_lista(anime_existentes)}\n"
    )


BATCH_SIZE = int(os.getenv("LLM_BATCH_SIZE", "10"))
NUM_CTX = int(os.getenv("LLM_NUM_CTX", "8192"))


def _build_system_prompt() -> str:
    """Construye el prompt de sistema (estructura NAS, reglas, ejemplos).

    Se calcula una sola vez por ejecución; el contexto del NAS se relee porque puede haber
    cambiado entre batches (improbable en una sola ejecución, pero correcto).
    """
    nas_context = gather_nas_context()
    reglas = (
        "REGLAS DE CLASIFICACIÓN:\n"
        "1. Si el nombre coincide o empieza por una SERIE YA CATALOGADA, devuelve tipo \"serie\" y serie = el nombre EXACTO de la carpeta existente.\n"
        "2. Patrones tipo \"1xNN\", \"S01E02\", \"01x05\", \"Cap. NN\", \"Episodio NN\" → tipo \"serie\".\n"
        "3. Si VARIOS archivos del lote comparten el mismo prefijo y SOLO difieren en un número final secuencial (1, 2, 3…), TODOS son tipo \"serie\" con serie = ese prefijo común. Ejemplo: \"Aventuras 1.mp4\", \"Aventuras 2.mp4\", \"Aventuras 3.mp4\" → los tres son serie \"Aventuras\".\n"
        "4. Año en prefijo (\"1984 - Terminator\") o sufijo \"(YYYY)\" + resolución (\"1920x1080\") → tipo \"pelicula\".\n"
        "5. Si pone \"anime\", subtítulos JP/CN/KR, fansub, u otra pista clara → tipo \"anime\".\n"
        "6. Cuando dudes entre serie y película, mira si hay algún episodio numerado: si sí, serie; si no, película.\n"
        "7. \"serie\" debe quedar vacío para tipo \"pelicula\" o \"anime\".\n"
        "8. El campo \"file\" debe ser EXACTAMENTE el nombre original recibido en el input, sin acortar, traducir ni alterar.\n"
    )
    ejemplos = (
        "EJEMPLOS:\n"
        "- \"La nena 04 Capítulo nuevo.mp4\" → {\"tipo\": \"serie\", \"serie\": \"La nena\"}\n"
        "- \"1984 - Terminator (1920x1080).mp4\" → {\"tipo\": \"pelicula\", \"serie\": \"\"}\n"
        "- \"Tiempos de Guerra - 1x08 - Los que nunca se rinden.mp4\" → {\"tipo\": \"serie\", \"serie\": \"Tiempos de Guerra\"}\n"
        "- \"Naruto Shippuden Ep 132 [HorribleSubs].mkv\" → {\"tipo\": \"anime\", \"serie\": \"\"}\n"
        "- INPUT: [\"Se tiene que morir mucha gente 1.mp4\", \"Se tiene que morir mucha gente 2.mp4\", \"Se tiene que morir mucha gente 3.mp4\"] → los TRES son {\"tipo\": \"serie\", \"serie\": \"Se tiene que morir mucha gente\"} (mismo prefijo + número final secuencial).\n"
    )
    return (
        "Eres un asistente que clasifica nombres de archivos de video en español para organizarlos en un NAS.\n"
        "Cada elemento del JSON de salida debe seguir este esquema:\n"
        "{ \"file\": \"nombre.ext\", \"tipo\": \"pelicula|serie|anime\", \"serie\": \"Nombre Serie\" }\n"
        "Responde SOLO un objeto JSON con la clave \"resultados\" (lista) que incluya TODOS los archivos del input, en el mismo orden y con el nombre \"file\" idéntico al recibido.\n"
        "\n"
        f"{nas_context}\n"
        f"{reglas}\n"
        f"{ejemplos}"
    )


def _classify_batch(base_url: str, model: str, system_prompt: str, names: list[str]) -> dict[str, dict]:
    """Llama al LLM con un lote de nombres y devuelve un mapping {nombre: {tipo, serie}}.

    Usa response_format JSON y `options.num_ctx` para evitar el truncado por defecto de Ollama
    (2048-4096 tokens) que provoca que el modelo alucine nombres genéricos cuando el prompt no
    cabe. Si la respuesta no se puede parsear, devuelve un mapping vacío y deja constancia en
    el log.
    """
    data = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(names, ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
        "options": {"num_ctx": NUM_CTX},
    }
    response = requests.post(f"{base_url}/chat/completions", json=data, timeout=600)
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    results = parse_llm_classification(content)
    mapping: dict[str, dict] = {}
    valid_names = set(names)
    for item in results:
        fname = item.get("file") or item.get("file_name") or item.get("name") or item.get("filename")
        if not fname or fname not in valid_names:
            continue
        tipo = (item.get("tipo") or item.get("type") or "").lower()
        serie_raw = item.get("serie") or item.get("series")
        serie = (serie_raw or "").strip() if isinstance(serie_raw, str) else ""
        mapping[fname] = {"tipo": tipo, "serie": serie}
    return mapping


def call_llm_for_videos(files: list[Path], model: str) -> dict[str, dict] | None:
    """Clasifica una lista de archivos de video usando el LLM local.

    Trocea la entrada en batches de BATCH_SIZE para evitar que la respuesta exceda el contexto
    del modelo. Si un batch falla devuelve None solo cuando ningún batch ha tenido éxito; si al
    menos uno ha funcionado, devuelve los matches conseguidos (los archivos sin matchear se
    quedan en TelegramDownloads y se reintentan en la próxima ejecución).
    """
    if not files:
        return {}
    base_url_raw = os.getenv("LOCAL_LLM_BASE_URL")
    if not base_url_raw:
        log("ADVERTENCIA: LOCAL_LLM_BASE_URL no definido; se omiten videos y se reintenta en la próxima ejecución.")
        return None
    base_url = base_url_raw.rstrip("/")

    system_prompt = _build_system_prompt()
    names = [f.name for f in files]
    total = len(names)
    mapping: dict[str, dict] = {}
    fallos = 0
    batches = [names[i : i + BATCH_SIZE] for i in range(0, total, BATCH_SIZE)]

    log(f"INFO: clasificando {total} videos en {len(batches)} batch(es) de hasta {BATCH_SIZE} (num_ctx={NUM_CTX})")

    for index, batch in enumerate(batches, start=1):
        try:
            batch_mapping = _classify_batch(base_url, model, system_prompt, batch)
            mapping.update(batch_mapping)
            log(f"INFO: batch {index}/{len(batches)} → {len(batch_mapping)}/{len(batch)} clasificados")
        except Exception as exc:
            fallos += 1
            log(f"ADVERTENCIA: batch {index}/{len(batches)} falló: {exc}")

    if fallos == len(batches):
        log(f"ADVERTENCIA: Todas las llamadas al LLM local ({base_url}) fallaron; se reintenta en la próxima ejecución.")
        return None

    return mapping


def parse_llm_classification(content: str) -> list[dict]:
    """Extrae la lista de clasificaciones del texto devuelto por el LLM.

    Tolera tres formas comunes que devuelven los LLMs locales:
      1. Bloque envuelto en ```json ... ``` (markdown code fence).
      2. Objeto JSON con la clave "resultados" (lo que pide el prompt).
      3. Array JSON suelto (algunos modelos como gemma lo devuelven directamente).
    Si no se puede parsear, devuelve lista vacía y deja constancia en el log.
    """
    text = (content or "").strip()
    # Quitar code fences ```json ... ``` o ``` ... ```
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    # Si sigue habiendo backticks sueltos, recortar lo que esté entre el primer { o [ y el último } o ]
    if text and text[0] not in "[{":
        first_obj = text.find("{")
        first_arr = text.find("[")
        candidates = [c for c in (first_obj, first_arr) if c >= 0]
        if candidates:
            text = text[min(candidates):]
    if text and text[-1] not in "]}":
        last_obj = text.rfind("}")
        last_arr = text.rfind("]")
        end = max(last_obj, last_arr)
        if end >= 0:
            text = text[: end + 1]
    try:
        parsed = json.loads(text)
    except Exception as exc:
        log(f"ADVERTENCIA: respuesta del LLM no es JSON válido tras limpieza ({exc}); preview: {text[:200]!r}")
        return []
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for key in ("resultados", "results", "items", "data"):
            if key in parsed and isinstance(parsed[key], list):
                return parsed[key]
        # Algunos modelos devuelven {file:..., tipo:..., serie:...} si solo hay 1 archivo
        if "file" in parsed and "tipo" in parsed:
            return [parsed]
    log(f"ADVERTENCIA: respuesta del LLM no contiene lista de resultados; preview: {str(parsed)[:200]!r}")
    return []


def run_comics_family_organizer() -> None:
    script = SRC_DIR / "organize_comics_families.py"
    if not script.exists():
        log("INFO: organize_comics_families.py no encontrado, se omite.")
        return
    env = os.environ.copy()
    env["BASE_DIR"] = str(BASE_DIR)
    log("INFO: Ejecutando organize_comics_families.py ...")
    result = subprocess.run(["python3", str(script), "--apply"], env=env, capture_output=True, text=True)
    if result.stdout:
        log(result.stdout.strip())
    if result.stderr:
        log(f"STDERR organizer: {result.stderr.strip()}")
    if result.returncode != 0:
        log(f"ADVERTENCIA: organize_comics_families.py terminó con código {result.returncode}")


def process_files() -> None:
    reset_log()
    ensure_directories()
    check_tools()

    video_files: list[Path] = []
    video_archives: list[Path] = []
    counters = {
        "peliculas": 0,
        "series": 0,
        "anime": 0,
        "libros": 0,
        "audiolibros": 0,
        "comics": 0,
        "errores": 0,
        "pendientes_api": 0,
        "sin_clasificar": 0,
    }

    for entry in DOWNLOADS_DIR.iterdir():
        if entry.is_dir() or entry.name.startswith("."):
            continue
        ext = entry.suffix.lower()

        if ext in VIDEO_EXTS:
            video_files.append(entry)
            continue
        if ext in BOOK_EXTS:
            if safe_move(entry, DEST_DIRS["books"]):
                counters["libros"] += 1
            continue
        if ext in AUDIOBOOK_EXTS:
            if safe_move(entry, DEST_DIRS["audiobooks"]):
                counters["audiolibros"] += 1
            continue
        if ext in COMIC_EXTS:
            moved = safe_move(entry, DEST_DIRS["comics"])
            if moved:
                counters["comics"] += 1
                # Conversión CBR→CBZ desactivada (2026-05-04): consumía minutos por archivo.
                # if moved.suffix.lower() == ".cbr":
                #     convert_cbr_to_cbz_and_delete(moved)
            continue
        if ext == ".zip":
            # Primero probar si es un ZIP de cómics
            comic_result = process_zip_for_comics(entry)
            if comic_result > 0:
                counters["comics"] += comic_result
                continue
            elif comic_result < 0:
                counters["errores"] += 1
                continue
            # Si no hay cómics, verificar si hay videos
            try:
                with zipfile.ZipFile(entry) as zf:
                    members = zf.namelist()
                    has_video = any(m.lower().endswith(tuple(VIDEO_EXTS)) for m in members)
                if has_video:
                    video_archives.append(entry)
                    continue
            except Exception as exc:
                log(f"ERROR: No se pudo inspeccionar ZIP {entry.name}: {exc}")
                counters["errores"] += 1
                continue
            # Si no es ZIP-de-cbr/cbz ni vídeo, mirar si es un .cbz disfrazado:
            # un ZIP cuyo contenido son directamente las imágenes del cómic.
            try:
                with zipfile.ZipFile(entry) as zf:
                    members = zf.namelist()
                    image_exts = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".bmp")
                    image_count = sum(1 for m in members if m.lower().endswith(image_exts))
                if members and image_count >= 5 and image_count / len(members) >= 0.7:
                    cbz_target = DEST_DIRS["comics"] / entry.with_suffix(".cbz").name
                    if cbz_target.exists():
                        log(f"ADVERTENCIA: {cbz_target.name} ya existe, dejo {entry.name} en TelegramDownloads")
                        continue
                    shutil.move(str(entry), str(cbz_target))
                    log(f"MOVIDO a COMICS (zip→cbz, {image_count} imágenes): {entry.name} -> {cbz_target}")
                    counters["comics"] += 1
                    continue
            except Exception as exc:
                log(f"ERROR: No se pudo inspeccionar imágenes en ZIP {entry.name}: {exc}")
            # No es nada conocido: se queda en TelegramDownloads (NO se mueve a OTROS).
            log(f"INFO: ZIP no clasificable, se deja en TelegramDownloads: {entry.name}")
            counters["errores"] += 1
            continue

        # Extensión no reconocida: se queda en TelegramDownloads (NO se mueve a OTROS).
        log(f"INFO: Extensión no clasificada, se deja en TelegramDownloads: {entry.name}")
        counters["errores"] += 1

    # Clasificación de videos: primero heurística determinista (agrupar por
    # prefijo común) y luego LLM para los restantes.
    model = os.getenv("LOCAL_LLM_MODEL", "")
    video_items = video_files + video_archives
    pre_series = detect_series_groups(video_items)
    if pre_series:
        log(f"INFO: heurística pre-LLM detectó {len(pre_series)} archivos como serie por prefijo común: "
            f"{sorted(set(pre_series.values()))}")
    remaining = [v for v in video_items if v.name not in pre_series]
    llm_mapping = call_llm_for_videos(remaining, model=model) if remaining else {}
    if llm_mapping is None:
        # Fallo total del LLM: aún podemos procesar los pre_series, el resto se reintenta luego.
        mapping = {fname: {"tipo": "serie", "serie": serie} for fname, serie in pre_series.items()}
        unclassified_remaining = [v for v in remaining]
        counters["pendientes_api"] = len(unclassified_remaining)
        if unclassified_remaining:
            pendientes = ", ".join(sorted(v.name for v in unclassified_remaining))
            log(f"Videos pendientes ({counters['pendientes_api']}): {pendientes}")
        if not pre_series:
            log("No se movieron por falta/fallo de API; se mantienen en TelegramDownloads.")
    else:
        # Merge: LLM tiene prioridad para los que clasificó; pre_series cubre el resto.
        mapping = dict(llm_mapping)
        for fname, serie in pre_series.items():
            if fname not in mapping:
                mapping[fname] = {"tipo": "serie", "serie": serie}
    # mapping is always a dict at this point (empty or merged). The flow below
    # processes each video using mapping.get; videos absent from mapping stay
    # in TelegramDownloads.
    if True:
        for video in video_items:
            info = mapping.get(video.name)
            if not info:
                log(f"ADVERTENCIA: Sin clasificación para {video.name}; se deja en TelegramDownloads.")
                counters["sin_clasificar"] += 1
                continue
            tipo = info.get("tipo", "pelicula")
            serie = info.get("serie", "")

            if video in video_archives:
                ok = process_zip_for_videos(video, tipo, serie)
                if ok:
                    if tipo == "serie":
                        counters["series"] += 1
                    elif tipo == "anime":
                        counters["anime"] += 1
                    else:
                        counters["peliculas"] += 1
                else:
                    counters["errores"] += 1
                continue

            if tipo == "serie":
                target_dir = DEST_DIRS["series"] / serie if serie else DEST_DIRS["series"] / "SinTitulo"
                moved = safe_move(video, target_dir)
                if moved:
                    counters["series"] += 1
            elif tipo == "anime":
                moved = safe_move(video, DEST_DIRS["anime"])
                if moved:
                    counters["anime"] += 1
            else:
                moved = safe_move(video, DEST_DIRS["movies"])
                if moved:
                    counters["peliculas"] += 1

    log(
        "RESUMEN: peliculas={peliculas}, series={series}, anime={anime}, libros={libros}, "
        "audiolibros={audiolibros}, comics={comics}, sin_clasificar={errores}, pendientes_api={pendientes_api}, sin_clasificacion_ai={sin_clasificar}".format(
            **counters
        )
    )
    run_comics_family_organizer()


if __name__ == "__main__":
    process_files()
