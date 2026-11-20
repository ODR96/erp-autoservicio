"""Cuentas de la factura leída por Gemini. Sin dependencias: se prueba sin la API.

Reglas del ERP (responsable inscripto):
- El costo que se guarda es el NETO SIN IVA de 1 unidad suelta, con la alícuota real aparte.
- Impuesto interno es costo (no se recupera): se suma al neto.
- Percepciones, flete y el IVA del pie no van al costo unitario: son cargos_extra
  (lo que falta para que el total del sistema cierre con el total del papel).
- Si el producto existe, la ficha manda: su alícuota y sus unidades por bulto.
- Solo la factura A (o M) da crédito fiscal. En C, B, remito o ticket no hay IVA que
  recuperar: el costo es el importe entero de la línea, aunque el precio "incluya" IVA.
"""

TIPOS_CON_CREDITO_FISCAL = ("A", "M")

ALICUOTA_POR_DEFECTO = 21.0
TOLERANCIA_CIERRE = 0.05


def _num(valor, por_defecto=0.0) -> float:
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return por_defecto
    return n if n == n else por_defecto  # descarta NaN


def _alicuota_papel(valor):
    """None si la línea no muestra alícuota (Gemini manda -1)."""
    n = _num(valor, -1.0)
    return None if n < 0 else n


def _alicuota_ficha(ficha):
    if not ficha:
        return None
    iva = ficha.get("porcentaje_iva")
    if iva is None or iva == "":
        return None
    n = _num(iva, -1.0)
    if n < 0:
        return None
    return n * 100 if 0 < n <= 1 else n


def _uxb_ficha(ficha):
    if not ficha:
        return None
    try:
        return max(1, int(ficha.get("unidades_por_bulto") or 1))
    except (TypeError, ValueError):
        return 1


def _neto_linea(linea: dict, precios_incluyen_iva: bool, descuento_general: float, alicuota: float) -> float:
    """Importe de la línea sin IVA, con la bonificación de la línea y la general del pie."""
    bultos = max(0.0, _num(linea.get("cantidad_bultos_o_packs")))
    importe = _num(linea.get("importe_linea"))
    if importe <= 0:
        precio = max(0.0, _num(linea.get("precio_unitario_impreso")))
        desc = min(100.0, max(0.0, _num(linea.get("descuento_porcentaje"))))
        importe = precio * bultos * (1 - desc / 100)
    importe *= (1 - min(100.0, max(0.0, descuento_general)) / 100)
    if precios_incluyen_iva:
        importe = importe / (1 + alicuota / 100)
    return max(0.0, importe)


def procesar_factura(leida: dict, fichas: list) -> dict:
    """leida: lo que transcribió Gemini. fichas: producto del catálogo por línea (o None), mismo orden.

    Devuelve los ítems con las cuentas hechas y los cargos del pie para cargos_extra.
    """
    lineas = list(leida.get("items") or [])
    fichas = list(fichas or []) + [None] * max(0, len(lineas) - len(fichas or []))
    tipo = str(leida.get("tipo_comprobante") or "").strip().upper()
    con_credito = tipo in TIPOS_CON_CREDITO_FISCAL
    divide_iva = con_credito and bool(leida.get("precios_incluyen_iva"))
    desc_general = _num(leida.get("descuento_general_porcentaje"))

    avisos_factura = []
    if not con_credito:
        avisos_factura.append(
            f"Comprobante {tipo or 'sin tipo'}: no hay IVA para recuperar, el costo es el importe entero de cada línea."
        )

    items = []
    for linea, ficha in zip(lineas, fichas):
        avisos = []
        alic_papel = _alicuota_papel(linea.get("alicuota_iva"))
        alic_ficha = _alicuota_ficha(ficha)
        if alic_ficha is not None:
            alicuota = alic_ficha
            if alic_papel is not None and abs(alic_papel - alic_ficha) > 0.01:
                avisos.append(f"La factura dice IVA {alic_papel:g} %, la ficha {alic_ficha:g} %: se usó la ficha.")
        elif alic_papel is not None:
            alicuota = alic_papel
        else:
            alicuota = ALICUOTA_POR_DEFECTO
            if con_credito:
                avisos.append("La línea no muestra IVA: se tomó 21 %. Al vincular se usa el de la ficha.")

        neto = _neto_linea(linea, divide_iva, desc_general, alicuota)
        neto += max(0.0, _num(linea.get("impuesto_interno_linea")))

        bultos = max(0.0, _num(linea.get("cantidad_bultos_o_packs")))
        try:
            uxb_papel = max(1, int(_num(linea.get("unidades_por_bulto"), 1)))
        except (TypeError, ValueError):
            uxb_papel = 1
        uxb_f = _uxb_ficha(ficha)

        if uxb_papel > 1:
            if ficha is not None:
                uxb = uxb_f
                if uxb_f != uxb_papel:
                    avisos.append(f"La factura dice x{uxb_papel}, la ficha x{uxb_f}: se usó la ficha.")
            else:
                uxb = uxb_papel
            modo = "CAJA" if uxb > 1 else "UN"
        else:
            uxb = uxb_f or 1
            modo = "UN"

        unidades = bultos * uxb if modo == "CAJA" else bultos
        if unidades <= 0:
            avisos.append("No se leyó la cantidad.")
        if neto <= 0:
            avisos.append("No se leyó el precio.")

        items.append({
            "codigo": str(linea.get("codigo") or ""),
            "descripcion": str(linea.get("descripcion") or ""),
            "cantidad_bultos_o_packs": bultos,
            "unidades_por_bulto": uxb,
            "unidades_totales_reales": unidades,
            "descuento_porcentaje": _num(linea.get("descuento_porcentaje")),
            "alicuota_iva": alicuota,
            "modo": modo,
            "iva_dividido": alicuota if divide_iva else None,
            "neto_linea": neto,
            "confianza": _num(linea.get("confianza"), 1.0),
            "avisos": avisos,
        })

    internos_pie = max(0.0, _num(leida.get("impuestos_internos_total")))
    suma_neta = sum(it["neto_linea"] for it in items)
    if internos_pie > 0 and suma_neta > 0:
        for it in items:
            it["neto_linea"] += internos_pie * it["neto_linea"] / suma_neta
        suma_neta += internos_pie

    for it in items:
        u = it["unidades_totales_reales"]
        costo = it["neto_linea"] / u if u > 0 else 0.0
        it["costo_unitario_neto_sin_iva"] = round(costo, 4)
        # Informativo: lo que te sale 1 unidad con IVA. No se guarda como costo de la ficha.
        it["costo_unitario_final_con_impuestos"] = round(costo * (1 + it["alicuota_iva"] / 100) if con_credito else costo, 4)

    total_papel = _num(leida.get("total_papel"))
    if total_papel > 0:
        cargos = total_papel - suma_neta
        if cargos < -TOLERANCIA_CIERRE:
            avisos_factura.append("Las líneas suman más que el total del papel. Revisá cantidades y precios.")
            cargos = 0.0
    else:
        iva_estimado = sum(it["neto_linea"] * it["alicuota_iva"] / 100 for it in items) if con_credito else 0.0
        cargos = iva_estimado + max(0.0, _num(leida.get("percepciones_y_otros_cargos")))

    return {
        "items": items,
        "cargos_pie": round(max(0.0, cargos), 2),
        "suma_neta": round(suma_neta, 2),
        "avisos": avisos_factura,
    }
