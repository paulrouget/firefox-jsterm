all:
	rm -f jsterm.xpi && zip -r jsterm.xpi bootstrap.js chrome/ chrome.manifest install.rdf
	wget --post-file=$(PWD)/jsterm.xpi http://localhost:8888/
