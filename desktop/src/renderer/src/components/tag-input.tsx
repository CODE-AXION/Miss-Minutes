import { useState, type JSX } from 'react'
import { Plus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { slugifyTag } from '@/lib/format'

/** Tag chips plus a combobox of known tags (suggested + already used); free entry is added in slugified form. */
export function TagInput({
  value,
  onChange,
  suggestions,
  id
}: {
  value: string[]
  onChange: (tags: string[]) => void
  /** Known tags, best first. */
  suggestions: string[]
  id?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const typed = slugifyTag(search)
  const available = suggestions.filter((t) => !value.includes(t))

  const add = (tag: string): void => {
    if (tag && !value.includes(tag)) onChange([...value, tag])
    setSearch('')
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 pr-1">
          {tag}
          <button
            type="button"
            className="rounded-sm opacity-70 hover:opacity-100"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(value.filter((t) => t !== tag))}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" size="sm" className="h-6 px-2 text-xs">
            <Plus /> Add tag
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput
              placeholder="Search or type a tag"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>{typed ? null : 'No more known tags'}</CommandEmpty>
              {typed && !value.includes(typed) && !available.includes(typed) && (
                <CommandGroup heading="New tag">
                  <CommandItem value={`new:${search}`} onSelect={() => add(typed)}>
                    <Plus /> Add “{typed}”
                  </CommandItem>
                </CommandGroup>
              )}
              {available.length > 0 && (
                <CommandGroup heading="Known tags">
                  {available.map((tag) => (
                    <CommandItem key={tag} value={tag} onSelect={() => add(tag)}>
                      {tag}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
