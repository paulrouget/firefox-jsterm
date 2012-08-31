FILES = chrome/ \
				locale/ \
				modules/ \
				bootstrap.js \
				chrome.manifest \
				install.rdf

all:
	rm -f jsterm.xpi && zip -r jsterm.xpi $(FILES)
	wget --post-file=$(PWD)/jsterm.xpi http://localhost:8889/
