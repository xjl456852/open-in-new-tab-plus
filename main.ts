import { Plugin, App, OpenViewState, Workspace, WorkspaceLeaf } from "obsidian";
import { around } from 'monkey-around';


export default class OpenInNewTabPlugin extends Plugin {
	uninstallMonkeyPatch: () => void;

	async onload() {
		this.monkeyPatchOpenLinkText();

		this.registerDomEvent(document, "click", this.generateClickHandler(this.app), {
			capture: true,
		});
	}

	onunload(): void {
		this.uninstallMonkeyPatch && this.uninstallMonkeyPatch();
	}

	monkeyPatchOpenLinkText() {
		// This logic is directly pulled from https://github.com/scambier/obsidian-no-dupe-leaves
		// In order to open link clicks in the editor in a new leaf, the only way it seems to be able to do this
		// is by monkey patching the openLinkText method. Not super great, but it works.
		this.uninstallMonkeyPatch = around(Workspace.prototype, {
			openLinkText(oldOpenLinkText) {
				return async function (
					linkText: string,
					sourcePath: string,
					newLeaf?: boolean,
					openViewState?: OpenViewState) {
					const fileName = linkText.split("#")?.[0];

					// Detect if we're clicking on a link within the same file. This can happen two ways:
					// [[LinkDemo#Header 1]] or [[#Header 1]]
					const isSameFile = fileName === "" || `${fileName}.md` === sourcePath;

					// Search existing panes and open that pane if the document is already open.
					let fileAlreadyOpen = false
					if (!isSameFile) {
						// Check all open panes for a matching path
						this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
							const viewState = leaf.getViewState()
							const matchesMarkdownFile = viewState.type === 'markdown' && viewState.state?.file?.endsWith(`${fileName}.md`);
							const matchesNonMarkdownFile = viewState.type !== 'markdown' && viewState.state?.file?.endsWith(fileName);

							if (
								matchesMarkdownFile || matchesNonMarkdownFile
							) {
								this.app.workspace.setActiveLeaf(leaf)
								fileAlreadyOpen = true
							}
						})
					}

					let openNewLeaf = true;
					if (isSameFile) {
						// This means it's a link to a heading or block on the same page. e.g. [[#Heading 1]] or [[#^asdf]]. In this case, fall back to the intended behavior passed in. This is necessary to preserve middle mouse button clicks.
						openNewLeaf = newLeaf || false;
					} else if (fileAlreadyOpen) {
						// If the file is already open in another leaf, we set the leaf active above, and we just want the old openLinkText function to handle stuff like highlighting or navigating to a header.
						openNewLeaf = false;
					}

					oldOpenLinkText &&
						oldOpenLinkText.apply(this, [
							linkText,
							sourcePath,
							openNewLeaf,
							openViewState,
						])
				}
			},
		})
	}


	generateClickHandler(appInstance: App) {
		return (event: MouseEvent) => {
			const target = event.target as Element;
			
			// Check if clicking on elements that should not trigger file opening
			const isCollapseIcon = target?.closest(".collapse-icon") ||
				target?.closest(".tree-item-icon.collapse-icon");
			const isHoverButton = target?.closest(".search-result-hover-button");
			
			if (isCollapseIcon || isHoverButton) {
				// Let the default behavior handle these elements
				return;
			}
			
			// Check for internal note links (links within note content)
			const internalLinkEl = target?.closest("a.cm-underline");
			const isInternalLink = internalLinkEl && !target?.closest(".nav-file") && !target?.closest(".search-result") && !target?.closest(".bookmark");
			
			// Check for file explorer navigation
			const isNavFile =
				target?.classList?.contains("nav-file-title") ||
				target?.classList?.contains("nav-file-title-content");
			const navTitleEl = target?.closest(".nav-file-title");
			
			// Check for search results - handle both title and match clicks
			// But we'll handle them differently to preserve match functionality
			const searchTitleEl = target?.closest(".search-result-file-title");
			const searchMatchEl = target?.closest(".search-result-file-match");
			const isSearchResultTitle = searchTitleEl && !isCollapseIcon && !isHoverButton;
			const isSearchResultMatch = searchMatchEl && !isCollapseIcon && !isHoverButton;
			const searchResultEl = target?.closest(".search-result");
			
			// Check for bookmarks - need to be more specific
			const bookmarkClickEl = target?.closest(".tree-item-self.bookmark");
			const isBookmark = bookmarkClickEl &&
				!bookmarkClickEl.classList.contains("mod-collapsible") &&
				!isCollapseIcon &&
				!isHoverButton;
			// Get the tree-item element that contains the data-path
			const bookmarkEl = bookmarkClickEl?.closest(".tree-item[data-path]");

			// Make sure it's just a left click so we don't interfere with anything.
			const pureClick =
				!event.shiftKey &&
				!event.ctrlKey &&
				!event.metaKey &&
				!event.altKey;

			if (!pureClick) {
				return;
			}

			let path: string | null = null;

			// Get the file path based on the clicked element
			if (isInternalLink && internalLinkEl) {
				// Internal note link - extract path from href or data attributes
				path = this.extractPathFromInternalLink(internalLinkEl);
			} else if (isNavFile && navTitleEl) {
				// File explorer
				path = navTitleEl.getAttribute("data-path");
			} else if ((isSearchResultTitle || isSearchResultMatch) && searchResultEl) {
				// Search results - need to extract path from the search result
				path = this.extractPathFromSearchResult(searchResultEl, target);
			} else if (isBookmark && bookmarkEl) {
				// Bookmarks - extract and validate path
				path = this.extractPathFromBookmark(bookmarkEl);
			}

			if (path && pureClick) {
				// Normalize path for comparison (ensure it has .md extension if it's a markdown file)
				const normalizedPath = this.normalizePath(path);
				
				// Check if the file is already open
				let fileAlreadyOpen = false;
				appInstance.workspace.iterateAllLeaves((leaf) => {
					const viewState = leaf.getViewState();
					if (viewState.state?.file) {
						// Compare normalized paths
						const openFilePath = viewState.state.file;
						const normalizedOpenPath = this.normalizePath(openFilePath);
						
						if (normalizedOpenPath === normalizedPath) {
							appInstance.workspace.setActiveLeaf(leaf);
							fileAlreadyOpen = true;
						}
					}
				});

				// Handle internal links
				if (isInternalLink) {
					if (!fileAlreadyOpen) {
						// Open in new tab if not already open
						event.stopPropagation();
						event.preventDefault();
						
						// Check for empty tabs first
						const emptyLeaves = appInstance.workspace.getLeavesOfType("empty");
						if (emptyLeaves.length > 0) {
							appInstance.workspace.setActiveLeaf(emptyLeaves[0]);
							// Let the default handler open the file in the empty tab
							setTimeout(() => {
								appInstance.workspace.openLinkText(normalizedPath, "", false);
							}, 0);
						} else {
							// Open in new tab
							appInstance.workspace.openLinkText(normalizedPath, "", true);
						}
					} else {
						// File is already open, we've activated it, prevent default
						event.stopPropagation();
						event.preventDefault();
					}
				}
				// Handle search results differently based on what was clicked
				else if (isSearchResultTitle) {
					// Title click - handle tab activation/creation
					if (!fileAlreadyOpen) {
						// If we have a "New Tab" tab open, just switch to that and let
						// the default behavior open the file in that.
						const emptyLeaves = appInstance.workspace.getLeavesOfType("empty");
						if (emptyLeaves.length > 0) {
							appInstance.workspace.setActiveLeaf(emptyLeaves[0]);
							return;
						}

						// Open in new tab if not already open
						event.stopPropagation();
						event.preventDefault();
						appInstance.workspace.openLinkText(normalizedPath, normalizedPath, true);
					} else {
						// File is already open, we've activated it, prevent default
						event.stopPropagation();
						event.preventDefault();
					}
				} else if (isSearchResultMatch) {
					// Match click - need special handling to preserve positioning while managing tabs
					if (!fileAlreadyOpen) {
						// File not open - we need to force it to open in a new tab
						// We'll simulate a Ctrl+Click (or Cmd+Click on Mac) to force new tab behavior
						event.stopPropagation();
						event.preventDefault();
						
						// Create a modified click event that simulates Ctrl/Cmd+Click
						const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
						const newEvent = new MouseEvent('click', {
							bubbles: true,
							cancelable: true,
							view: window,
							button: 0,
							buttons: 1,
							clientX: event.clientX,
							clientY: event.clientY,
							ctrlKey: !isMac,  // Ctrl for Windows/Linux
							metaKey: isMac,   // Cmd for Mac
							shiftKey: false,
							altKey: false
						});
						
						// Dispatch the modified event to let Obsidian handle it with new tab behavior
						target.dispatchEvent(newEvent);
					} else {
						// File is already open, we've already activated the tab above
						// Let the default behavior handle positioning and highlighting
						// Don't prevent default - let Obsidian handle the navigation
						return;
					}
				} else {
					// For nav files and bookmarks, handle as before
					if (!fileAlreadyOpen) {
						const emptyLeaves = appInstance.workspace.getLeavesOfType("empty");
						if (emptyLeaves.length > 0) {
							appInstance.workspace.setActiveLeaf(emptyLeaves[0]);
							return;
						}

						// Open in new tab if not already open
						event.stopPropagation();
						event.preventDefault();
						appInstance.workspace.openLinkText(normalizedPath, normalizedPath, true);
					} else {
						// File is already open, we've activated it, prevent default
						event.stopPropagation();
						event.preventDefault();
					}
				}
			}
		}
	}

	/**
	 * Extract file path from internal note link
	 */
	private extractPathFromInternalLink(linkEl: Element): string | null {
		// Try to get the href attribute
		const href = linkEl.getAttribute("href");
		if (href && href !== "#") {
			// Decode the URL-encoded path
			const decodedPath = decodeURIComponent(href);
			// Remove any leading hash or relative path indicators
			let cleanPath = decodedPath.replace(/^#/, '').replace(/^\.\//, '').replace(/^\.\.\//, '');
			
			// If it's a relative path with multiple ../, resolve it
			if (decodedPath.includes('../')) {
				// Get the current file path
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					const currentDir = activeFile.parent?.path || '';
					// Count how many levels to go up
					const upLevels = (decodedPath.match(/\.\.\//g) || []).length;
					// Split current directory and go up the required levels
					const dirParts = currentDir.split('/').filter(p => p);
					for (let i = 0; i < upLevels && dirParts.length > 0; i++) {
						dirParts.pop();
					}
					// Remove all ../ from the path
					cleanPath = decodedPath.replace(/(\.\.\/)*/g, '');
					// Combine the resolved directory with the file path
					if (dirParts.length > 0) {
						cleanPath = dirParts.join('/') + '/' + cleanPath;
					}
				}
			}
			
			// Remove .md extension if present (will be added back in normalizePath if needed)
			cleanPath = cleanPath.replace(/\.md$/, '');
			
			return cleanPath;
		}
		
		// Try to get from data attributes or Obsidian's internal properties
		const anyEl = linkEl as any;
		
		// Check for Obsidian's internal file reference
		const file = anyEl.file ||
					anyEl._file ||
					anyEl.dataset?.href ||
					anyEl.dataset?.path ||
					anyEl.__vueParentComponent?.props?.file ||
					anyEl.__reactInternalInstance?.memoizedProps?.file;
		
		if (file) {
			if (typeof file === 'string') {
				return file;
			} else if (file.path) {
				return file.path;
			}
		}
		
		// Try to extract from link text if it looks like a file name
		const linkText = linkEl.textContent?.trim();
		if (linkText) {
			// Try to find the file in the vault by name
			const files = this.app.vault.getFiles();
			for (const file of files) {
				if (file.basename === linkText || file.name === linkText) {
					return file.path;
				}
			}
		}
		
		return null;
	}

	/**
	 * Extract file path from search result element
	 * Tries multiple methods as Obsidian's internal structure may vary
	 */
	private extractPathFromSearchResult(searchResultEl: Element, target: Element): string | null {
		// Method 1: Look for Obsidian's internal file reference
		// Check various elements where Obsidian might store the file reference
		const elementsToCheck = [
			searchResultEl,
			searchResultEl.querySelector(".tree-item-self"),
			target.closest(".tree-item-self"),
			searchResultEl.querySelector(".search-result-file-title"),
			target.closest(".search-result-file-title")
		];
		
		for (const el of elementsToCheck) {
			if (!el) continue;
			
			// Try to access Obsidian's internal properties
			const anyEl = el as any;
			
			// Check for file object in various possible locations
			const file = anyEl.file ||
						anyEl._file ||
						anyEl.dataset?.filePath ||
						anyEl.__vueParentComponent?.props?.file ||
						anyEl.__vueParentComponent?.ctx?.file ||
						anyEl.__reactInternalInstance?.memoizedProps?.file ||
						anyEl.__reactFiber?.memoizedProps?.file;
			
			if (file) {
				if (typeof file === 'string') {
					return file;
				} else if (file.path) {
					return file.path;
				} else if (file.name) {
					// If only name is available, assume it's a markdown file
					return file.name.endsWith('.md') ? file.name : `${file.name}.md`;
				}
			}
		}
		
		// Method 2: Try to find the file path from parent search view
		const searchView = searchResultEl.closest(".search-results-children");
		if (searchView) {
			// Get the index of this search result
			const allResults = searchView.querySelectorAll(".search-result");
			let resultIndex = -1;
			allResults.forEach((result, index) => {
				if (result === searchResultEl) {
					resultIndex = index;
				}
			});
			
			// Try to access the search plugin's data
			const searchPlugin = (this.app as any).internalPlugins?.plugins?.["global-search"];
			if (searchPlugin?.instance?.searchResults?.[resultIndex]) {
				const result = searchPlugin.instance.searchResults[resultIndex];
				if (result.file?.path) {
					return result.file.path;
				}
			}
		}
		
		// Method 3: Extract from the DOM text content as last resort
		const titleElement = searchResultEl.querySelector(".tree-item-inner");
		if (titleElement) {
			const titleText = titleElement.textContent?.trim();
			if (titleText) {
				// Try to find the file in the vault by name
				const files = this.app.vault.getFiles();
				for (const file of files) {
					if (file.basename === titleText || file.name === titleText) {
						return file.path;
					}
				}
				
				// If not found, assume it's a markdown file
				if (!titleText.includes('.')) {
					return `${titleText}.md`;
				}
				return titleText;
			}
		}
		
		return null;
	}

	/**
		* Extract and validate file path from bookmark element
		*/
	private extractPathFromBookmark(bookmarkEl: Element): string | null {
		const rawPath = bookmarkEl.getAttribute("data-path");
		if (!rawPath) return null;
		
		// Check if this is a folder bookmark (has mod-collapsible class)
		const bookmarkSelf = bookmarkEl.querySelector(".tree-item-self.bookmark");
		if (bookmarkSelf?.classList.contains("mod-collapsible")) {
			// This is a folder, not a file
			return null;
		}
		
		// The path from bookmark might not have extension
		// Check if the path already has an extension
		if (rawPath.match(/\.\w+$/)) {
			// Already has extension
			return rawPath;
		}
		
		// Try to find the actual file in the vault
		const files = this.app.vault.getFiles();
		
		// First try exact match with .md extension
		const mdPath = `${rawPath}.md`;
		if (files.some(f => f.path === mdPath)) {
			return mdPath;
		}
		
		// Try to find any file that starts with this path
		for (const file of files) {
			if (file.path === rawPath || file.path.startsWith(`${rawPath}.`)) {
				return file.path;
			}
		}
		
		// Try to match by basename (in case the bookmark stores a different format)
		const pathParts = rawPath.split('/');
		const basename = pathParts[pathParts.length - 1];
		for (const file of files) {
			if (file.basename === basename) {
				return file.path;
			}
		}
		
		// Default to adding .md extension
		return mdPath;
	}

	/**
		* Normalize file path for consistent comparison
		* Ensures markdown files have .md extension
		*/
	private normalizePath(path: string): string {
		if (!path) return path;
		
		// If path already has an extension, return as is
		if (path.match(/\.\w+$/)) {
			return path;
		}
		
		// Check if a file with .md extension exists
		const mdPath = `${path}.md`;
		const files = this.app.vault.getFiles();
		
		// Check if the .md version exists
		if (files.some(f => f.path === mdPath)) {
			return mdPath;
		}
		
		// Check if the path without extension exists
		if (files.some(f => f.path === path)) {
			return path;
		}
		
		// Default to .md for markdown files
		return mdPath;
	}
}

