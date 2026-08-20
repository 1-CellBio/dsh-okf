import { useState } from "react";
import type { OkfLocaleKey } from "./locales.ts";
import type { PathFieldName, PathFieldState, PathsCardState } from "./paths-form.ts";
import css from "./PathsCard.module.css";

export type PathsCardProps = {
  t: (key: OkfLocaleKey) => string;
  useKgPaths: (select: (state: PathsCardState) => PathsCardState) => PathsCardState;
  edit: (field: PathFieldName, text: string) => void;
  resetField: (field: PathFieldName) => void;
  save: () => void;
  discard: () => void;
};

const FIELDS: Array<{ field: PathFieldName; label: OkfLocaleKey; hint: OkfLocaleKey }> = [
  { field: "okfDir", label: "paths.okfDir", hint: "paths.okfDirHint" },
  { field: "pdfDir", label: "paths.pdfDir", hint: "paths.pdfDirHint" },
  { field: "exportDir", label: "paths.exportDir", hint: "paths.exportDirHint" },
];

export function PathsCard(props: PathsCardProps) {
  const { t } = props;
  const state = props.useKgPaths((snapshot) => snapshot);
  const [open, setOpen] = useState(false);
  if (!state.available) {
    return null;
  }
  const title = t("paths.title");
  const blocked = !state.dirty || state.saving;
  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? "paths.collapse" : "paths.expand")}: ${title}`}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t("paths.description")}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t("paths.unsaved")}</span> : null}
        <span className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} aria-hidden />
      </button>
      {open ? (
        <div className={css.body}>
          {!state.writable ? <p className={css.readOnly} role="status">{t("paths.readOnly")}</p> : null}
          {FIELDS.map((item) => (
            <PathField
              key={item.field}
              id={`kg-path-${item.field}`}
              label={t(item.label)}
              hint={t(item.hint)}
              overriddenLabel={t("paths.overridden")}
              resetLabel={t("paths.reset")}
              disabled={!state.writable}
              field={state[item.field]}
              onEdit={(text) => {
                props.edit(item.field, text);
              }}
              onReset={() => {
                props.resetField(item.field);
              }}
            />
          ))}
          <div className={css.footer}>
            {state.failed ? <p className={css.failed} role="status">{t("paths.saveFailed")}</p> : null}
            <button
              type="button"
              className={css.discard}
              disabled={!state.dirty || state.saving}
              onClick={props.discard}
            >
              {t("paths.discard")}
            </button>
            <button
              type="button"
              className={css.save}
              disabled={blocked}
              onClick={props.save}
            >
              {t(state.saving ? "paths.saving" : "paths.save")}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function PathField(props: {
  id: string;
  label: string;
  hint: string;
  overriddenLabel: string;
  resetLabel: string;
  disabled: boolean;
  field: PathFieldState;
  onEdit: (text: string) => void;
  onReset: () => void;
}) {
  return (
    <div className={css.field}>
      <div className={css.fieldHead}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.field.overridden ? (
          <span className={css.badges}>
            <span className={css.badge}>{props.overriddenLabel}</span>
            <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
              {props.resetLabel}
            </button>
          </span>
        ) : null}
      </div>
      <input
        id={props.id}
        className={css.input}
        type="text"
        spellCheck={false}
        value={props.field.text}
        disabled={props.disabled}
        onChange={(event) => {
          props.onEdit(event.target.value);
        }}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  );
}
