import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import type { FileFilter } from '@shared/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

/** One settings section: a card with a title and its fields. */
export function SettingsSection({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <FieldGroup className="grid gap-6 md:grid-cols-2">{children}</FieldGroup>
      </CardContent>
    </Card>
  )
}

interface Common {
  id: string
  label: string
  /** The argparse help string, verbatim where there is one. */
  description?: ReactNode
  error?: string
  className?: string
}

export function TextSetting({
  id,
  label,
  description,
  error,
  className,
  value,
  placeholder,
  onChange
}: Common & {
  value: string
  placeholder?: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <Field className={className} data-invalid={!!error || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        aria-invalid={!!error}
        onChange={(e) => onChange(e.target.value)}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/**
 * A number input that keeps what the user typed while it is not a valid number, and reports validity separately,
 * so "abc" or an out-of-range port can't be saved but is not silently replaced either.
 */
export function NumberSetting({
  id,
  label,
  description,
  className,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  onValidity
}: Common & {
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (value: number) => void
  onValidity: (id: string, valid: boolean) => void
}): JSX.Element {
  const [text, setText] = useState(String(value))
  // Follow outside changes (Discard, the slider) unless the text already means that value.
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (text.trim() === '' || Number(text) !== value) setText(String(value))
  }

  const number = Number(text)
  const error =
    text.trim() === '' || !Number.isFinite(number)
      ? 'Enter a number'
      : number < min || number > max
        ? `Between ${min} and ${max}`
        : Math.abs(number / step - Math.round(number / step)) > 1e-9
          ? step === 1
            ? 'Whole numbers only'
            : `In steps of ${step}`
          : undefined

  useEffect(() => {
    onValidity(id, !error)
  }, [id, error, onValidity])

  return (
    <Field className={className} data-invalid={!!error || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="decimal"
          className="w-32 tabular-nums"
          value={text}
          aria-invalid={!!error}
          onChange={(e) => {
            setText(e.target.value)
            const n = Number(e.target.value)
            if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n)
          }}
        />
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      {description && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/** A path with a Browse button (folder or file picker); typing is allowed too. */
export function PathSetting({
  id,
  label,
  description,
  error,
  className,
  value,
  kind,
  filters,
  placeholder,
  onChange
}: Common & {
  value: string
  kind: 'folder' | 'file'
  filters?: FileFilter[]
  placeholder?: string
  onChange: (value: string) => void
}): JSX.Element {
  async function browse(): Promise<void> {
    const picked =
      kind === 'folder' ? await window.api.pickFolder() : await window.api.pickFile(filters)
    if (picked) onChange(picked)
  }
  return (
    <Field className={className} data-invalid={!!error || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={id}
          className="font-mono text-xs"
          value={value}
          placeholder={placeholder}
          aria-invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button type="button" variant="outline" onClick={() => void browse()}>
          <FolderOpen /> Browse
        </Button>
      </div>
      {description && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

export function SwitchSetting({
  id,
  label,
  description,
  className,
  checked,
  disabled,
  onChange
}: Common & {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <Field orientation="horizontal" className={className}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Field>
  )
}
