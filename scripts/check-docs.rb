# frozen_string_literal: true

require "yaml"

ROOT = File.expand_path("..", __dir__)
ERRORS = []

Dir.glob(File.join(ROOT, ".github/ISSUE_TEMPLATE/*.{yml,yaml}")).sort.each do |path|
  YAML.safe_load(
    File.read(path),
    permitted_classes: [],
    permitted_symbols: [],
    aliases: true
  )
rescue Psych::Exception => error
  ERRORS << "#{path.delete_prefix("#{ROOT}/")}: invalid YAML: #{error.message}"
end

markdown_files = Dir.glob(File.join(ROOT, "**/*.md"), File::FNM_DOTMATCH)

markdown_files.sort.each do |file|
  File.read(file).scan(/\[[^\]]*\]\(([^)]+)\)/).flatten.each do |target|
    path = target.split("#", 2).first
    next if path.empty? || path.match?(%r{\A(?:https?://|mailto:)})

    resolved = File.expand_path(path, File.dirname(file))
    next if File.exist?(resolved)

    relative_file = file.delete_prefix("#{ROOT}/")
    ERRORS << "#{relative_file}: missing relative link target #{target}"
  end
end

unless ERRORS.empty?
  warn ERRORS.join("\n")
  exit 1
end

puts "Documentation checks passed."
