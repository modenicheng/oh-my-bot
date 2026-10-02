package main

import (
	"io/fs"
	"math"
	"path"
	"sort"
	"strconv"
	"strings"
)

type manualMeta struct {
	Title    string
	Audience string
	Tags     []string
	Order    *float64
}

type manualNode struct {
	Path     string       `json:"path"`
	Title    string       `json:"title"`
	Tags     []string     `json:"tags,omitempty"`
	Order    *float64     `json:"order,omitempty"`
	Children []manualNode `json:"children,omitempty"`
}

// Only the flat navigation keys are consumed. Unknown YAML is left to document authors.
// An unfinished header is never interpreted as metadata.
func manualFrontmatter(raw string) manualMeta {
	raw = strings.TrimPrefix(raw, string(rune(0xfeff)))
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	if len(lines) < 2 || strings.TrimSpace(lines[0]) != "---" {
		return manualMeta{}
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return manualMeta{}
	}
	meta := manualMeta{}
	inTags := false
	addTag := func(raw string) {
		value := manualScalar(raw)
		if value == "" {
			return
		}
		for _, t := range meta.Tags {
			if t == value {
				return
			}
		}
		meta.Tags = append(meta.Tags, value)
	}
	for _, raw := range lines[1:end] {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if inTags && strings.HasPrefix(line, "- ") {
			addTag(strings.TrimSpace(line[2:]))
			continue
		}
		inTags = false
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		switch strings.TrimSpace(key) {
		case "title":
			meta.Title = manualScalar(value)
		case "audience":
			meta.Audience = strings.ToLower(manualScalar(value))
		case "order":
			if n, err := strconv.ParseFloat(manualScalar(value), 64); err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) {
				meta.Order = &n
			}
		case "tag", "tags":
			if value == "" {
				inTags = true
				continue
			}
			if strings.HasPrefix(value, "[") {
				if close := strings.LastIndex(value, "]"); close > 0 {
					for _, item := range manualTagList(value[1:close]) {
						addTag(item)
					}
				}
			} else {
				addTag(value)
			}
		}
	}
	return meta
}

func manualScalar(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "\"") {
		// Quoted values may contain #, commas and colons. A comment may follow the closing quote.
		for i := 1; i < len(raw); i++ {
			if raw[i] == '\\' {
				i++
				continue
			}
			if raw[i] == '"' {
				value, err := strconv.Unquote(raw[:i+1])
				if err == nil {
					return value
				}
				return ""
			}
		}
		return ""
	}
	if strings.HasPrefix(raw, "'") {
		var value strings.Builder
		for i := 1; i < len(raw); i++ {
			if raw[i] != '\'' {
				value.WriteByte(raw[i])
				continue
			}
			if i+1 < len(raw) && raw[i+1] == '\'' {
				value.WriteByte('\'')
				i++
				continue
			}
			return value.String()
		}
		return ""
	}
	if i := strings.Index(raw, " #"); i >= 0 {
		raw = raw[:i]
	}
	raw = strings.TrimSpace(raw)
	if raw == "null" || raw == "~" || raw == "|" || raw == ">" {
		return ""
	}
	return raw
}

func manualTagList(raw string) []string {
	var result []string
	start, quote := 0, byte(0)
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if quote != 0 {
			if c == '\\' && quote == '"' {
				i++
				continue
			}
			if c == quote {
				if quote == '\'' && i+1 < len(raw) && raw[i+1] == quote {
					i++
				} else {
					quote = 0
				}
			}
		} else if c == '"' || c == '\'' {
			quote = c
		} else if c == ',' {
			result = append(result, raw[start:i])
			start = i + 1
		}
	}
	return append(result, raw[start:])
}

// Directory index.md owns its chapter's label/order; paths always remain API-relative.
func buildManualTreeFS(fsys fs.FS, root string) []manualNode {
	var walk func(string) []manualNode
	walk = func(dir string) []manualNode {
		entries, err := fs.ReadDir(fsys, dir)
		if err != nil {
			return []manualNode{}
		}
		out := []manualNode{}
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			full := path.Join(dir, name)
			rel := strings.TrimPrefix(strings.TrimPrefix(full, root+"/"), "./")
			node := manualNode{Path: strings.TrimSuffix(rel, ".md"), Title: strings.TrimSuffix(name, ".md")}
			source := full
			if entry.IsDir() {
				node.Children = walk(full)
				if len(node.Children) == 0 {
					continue
				}
				source = path.Join(full, "index.md")
			} else if !strings.HasSuffix(name, ".md") {
				continue
			}
			if raw, err := fs.ReadFile(fsys, source); err == nil {
				meta := manualFrontmatter(string(raw))
				if meta.Title != "" {
					node.Title = meta.Title
				}
				node.Tags, node.Order = meta.Tags, meta.Order
			}
			out = append(out, node)
		}
		sort.SliceStable(out, func(i, j int) bool {
			a, b := out[i], out[j]
			if (a.Order == nil) != (b.Order == nil) {
				return a.Order != nil
			}
			if a.Order != nil && *a.Order != *b.Order {
				return *a.Order < *b.Order
			}
			return a.Path < b.Path
		})
		return out
	}
	return walk(root)
}

// loadAIManualCorpusFS loads only chapters explicitly marked audience: both.
// The source is the same embedded/on-disk manual served to players, so AI and
// human documentation cannot silently drift apart. Frontmatter is retained: it
// is harmless context and keeps each chapter self-describing.
func loadAIManualCorpusFS(fsys fs.FS, root string) []string {
	var corpus []string
	_ = fs.WalkDir(fsys, root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() || !strings.HasSuffix(name, ".md") {
			return nil
		}
		raw, err := fs.ReadFile(fsys, name)
		if err != nil || manualFrontmatter(string(raw)).Audience != "both" {
			return nil
		}
		corpus = append(corpus, string(raw))
		return nil
	})
	sort.Strings(corpus)
	return corpus
}
