"""Validate output edits by replaying their journal before persisting the snapshot."""
from copy import deepcopy
import re


def position(well):
    if not isinstance(well, str) or not re.fullmatch(r"[A-H](?:[1-9]|1[0-2])", well):
        raise ValueError("ウェル番号を確認してください。")
    return ord(well[0]) - 65, int(well[1:]) - 1


def validate_edit(payload):
    meta = payload["plateEdit"]
    if meta["version"] != 1 or not meta["rootRefs"] or not 1 <= len(meta["parentRefs"]) <= 24:
        raise ValueError("元データの参照を確認してください。")
    for ref in meta["rootRefs"] + meta["parentRefs"]:
        if not isinstance(ref, str) or not re.fullmatch(r"(?:local:)?[\w-]{1,128}", ref):
            raise ValueError("元データの参照が不正です。")
    sources = deepcopy(meta.get("initialSourcePlates", payload["plates"]))
    final, initial = payload["packedPlates"], meta["initialPackedPlates"]
    if not sources or len(sources) > 1998 or not initial or len(initial) > 2000 or len(final) != len(initial):
        raise ValueError("プレート数を確認してください。")
    ids = set()
    origins = set()
    for p in sources:
        if p["uid"] in ids:
            raise ValueError("入力プレートの識別子が重複しています。")
        ids.add(p["uid"])
        origin = p["sourceOrigin"]
        for key in ("namespace", "uid"):
            if not isinstance(origin[key], str) or not re.fullmatch(r"[\w-]{1,160}", origin[key]):
                raise ValueError("元サンプル識別子が不正です。")
        identity = (origin["namespace"], origin["uid"])
        if identity in origins:
            raise ValueError("元プレートが重複しています。")
        origins.add(identity)
        if len(p["wells"]) != len(set(p["wells"])):
            raise ValueError("入力ウェルが重複しています。")
        for w in p["wells"]:
            position(w)
    seen = set()
    plate_ids = set()
    for plate in initial:
        if not isinstance(plate["id"], str) or plate["id"] in plate_ids:
            raise ValueError("出力プレート名が重複しています。")
        plate_ids.add(plate["id"])
        g = plate["grid"]
        if len(g) != 8 or any(not isinstance(row, list) or len(row) != 12 for row in g):
            raise ValueError("96ウェルの配置を確認してください。")
        for row in g:
            for cell in row:
                if cell is None:
                    continue
                source = cell["sourcePlate"]
                if not isinstance(source, str) or not source.isdigit() or not 1 <= int(source) <= len(sources) or str(int(source)) != source:
                    raise ValueError("元プレートが不正です。")
                position(cell["sourceWell"])
                if cell["sourceWell"] not in sources[int(source)-1]["wells"]:
                    raise ValueError("元ウェルが存在しません。")
                identity = (source, cell["sourceWell"])
                if identity in seen:
                    raise ValueError("同じ試料が複数の出力ウェルにあります。")
                seen.add(identity)
    replay = deepcopy(initial)

    def board(index):
        if type(index) is not int or not 0 <= index < len(replay):
            raise ValueError("プレート番号が不正です。")
        return replay[index]["grid"]

    actions = meta["operations"]
    if not isinstance(actions, list) or len(actions) > 10000:
        raise ValueError("変更履歴を確認してください。")
    for action in actions:
        names = action["wells"]
        if not names or len(names) > 96 or len(names) != len(set(names)):
            raise ValueError("選択ウェルを確認してください。")
        src = board(action["from"])
        points = [position(w) for w in names]
        values = [src[r][c] for r, c in points]
        if not any(v is not None for v in values):
            raise ValueError("空の選択範囲です。")
        if action["type"] == "correct-source":
            if "initialSourcePlates" not in meta or len(names) != 1:
                raise ValueError("訂正するウェルを1つ選択してください。")
            cell = values[0]
            source, target = action["sourcePlate"], action["sourceWell"]
            position(target)
            if not isinstance(source, str) or not source.isdigit() or not 1 <= int(source) <= len(sources) or str(int(source)) != source:
                raise ValueError("入力プレートを確認してください。")
            if action["before"] != {"sourcePlate": cell["sourcePlate"], "sourceWell": cell["sourceWell"]}:
                raise ValueError("訂正前の入力元が一致しません。")
            if any(c and c["sourcePlate"] == source and c["sourceWell"] == target for p in replay for row in p["grid"] for c in row):
                raise ValueError("訂正先の入力元は使用済みです。")
            old, dest = sources[int(cell["sourcePlate"])-1], sources[int(source)-1]
            phase = dest.get("growthWeeks", {}).get(target, cell.get("growthWeek"))
            old["wells"] = [w for w in old["wells"] if w != cell["sourceWell"]]
            old.get("growthWeeks", {}).pop(cell["sourceWell"], None)
            if target not in dest["wells"]:
                dest["wells"].append(target)
            if phase is not None:
                dest.setdefault("growthWeeks", {})[target] = phase
                cell["growthWeek"] = phase
            cell["sourcePlate"], cell["sourceWell"] = source, target
        elif action["type"] == "delete":
            for r, c in points:
                src[r][c] = None
        elif action["type"] == "move":
            dest = board(action["to"])
            if action["anchor"] not in names:
                raise ValueError("移動の基準を確認してください。")
            ar, ac = position(action["anchor"])
            tr, tc = position(action["target"])
            targets = [(r+tr-ar, c+tc-ac) for r, c in points]
            if any(not 0 <= r < 8 or not 0 <= c < 12 for r, c in targets):
                raise ValueError("移動先が範囲外です。")
            if len(names) == 1:
                r, c = points[0]
                nr, nc = targets[0]
                src[r][c], dest[nr][nc] = dest[nr][nc], values[0]
            else:
                if any(dest[r][c] is not None for r, c in targets):
                    raise ValueError("範囲移動先に試料があります。")
                for r, c in points:
                    src[r][c] = None
                for (r, c), value in zip(targets, values):
                    dest[r][c] = value
        else:
            raise ValueError("不明な操作です。")
    if replay != final:
        raise ValueError("変更履歴と保存する配置が一致しません。")
    if sources != payload["plates"]:
        raise ValueError("変更履歴と入力元が一致しません。")
