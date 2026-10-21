# GlobalStorybooks.net audio recordings

## PLACEHOLDER REPO -- AUDIO DATA CAN BE FOUND IN OUR [REPO ON GITLAB](https://gitlab.com/global-asp/gsn-audio)

This repository contains multilingual studio-recorded and post-processed audio for the [Global Storybooks](http://globalstorybooks.net) projects. The audio consists of readings of a collection of 40 storybooks from the [African Storybook](http://africanstorybook.org). All of the stories can be read and listened to [here](http://storybookscanada.ca) in English, French, and many other languages.

## Structure

All audio files can be found in the `audio` folder within this repo, arranged by language. See the [section below](#languages) for a list of language codes.

Within each language folder, the 40 stories in the collection are arranged in separate folders by their individual 4-digit [story ID](#stories).

The story folders each contain a single full-length MP3 file, as well as a folder labelled `mp3`. The full-length MP3 file contains the entire story being read aloud as a single file, while the files in the `mp3` folder have been split into individual pages from the full-length file. If you just want to hear the story read aloud, you will probably want the full-length file only. However, the split files have multiple possibilities for alternative uses and extended applications.

## Languages

The following languages are included in this repo, listed in order of [ISO language code](http://en.wikipedia.org/wiki/ISO_639-1). If a language listed below is not in the audio folder of this repository it is most likely in the process of being edited, and will be released as soon as a final version is ready.

ISO code | Language name | Reader
-------- | ------------- | ------
am | Amharic | Abenezer Chane
ar | Arabic | Mashael Muhanna
bn | Bengali | Asma Afreen
de | German | Jula Eberth
en | English | Darshan Soni
es | Spanish | Áurea Vericat
fa | Persian (Farsi) | Nasim Peikazadi
fr | French | Alexandra Danahy
it | Italian | Sonia Pighini
ko | Korean | Scarlet Kim
pa | Punjabi | Gurleen Parmar
pl | Polish | Helena Kudzia
pt | Portuguese (Brazil) | Alfredo Ferreira
so | Somali | Ibrahim Ahmed
sw | Swahili | Sophia Turunesh Mufuruki
tl | Tagalog | La Trinidad Mina
tr | Turkish | Leyla Tekül
ur | Urdu | Sadia Shad
yue | Chinese (Cantonese) | Zoe Lam
zh | Chinese (Mandarin) | Zhuo Sun

## Filenames

The full and split files follow the following naming conventions:

1. Full files: `[ISO Language code]-[Story ID]_[Story shortcode].mp3`
2. Split files: `[Page #].mp3`

This makes it easier for web applications, scripts, and other tools to precisely locate the individual audio track for a particular page of a story in a specific language, or the full audio of that story, within the folder structure of the repo.

For example, the Arabic audio for the 5th page of the story _A Very Tall Man_ can be found at:

    /audio/ar/mp3/05.mp3

Likewise, the full audio would be in:

    /audio/ar/ar-0001_tall.mp3

## Stories

The following stories from the [African Storybook](http://africanstorybook.org) are included in the collection, arranged in order of their Story ID.

Titles in the table below are linked to the original story on the African Storybook website. Story IDs are linked to the individual story pages on Storybooks Canada, where the stories can be read while listening to the audio.

Please note the different licenses for each story, as the license for the audio recordings follows the license for the original story.

Story ID | Title | Shortcode | License
-------- | ----- | --------- | -------
[0001](http://storybookscanada.ca/stories/en/0001) | [A very tall man](http://africanstorybook.org/reader.php?id=918) | tall | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0002](http://storybookscanada.ca/stories/en/0002) | [Look at the animals](http://africanstorybook.org/reader.php?id=1221) | animals | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0003](http://storybookscanada.ca/stories/en/0003) | [School clothes](http://africanstorybook.org/reader.php?id=1794) | clothes | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0004](http://storybookscanada.ca/stories/en/0004) | [Goat, Dog and Cow](http://africanstorybook.org/reader.php?id=6380) | goat | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0006](http://storybookscanada.ca/stories/en/0006) | [Anansi and Wisdom](http://africanstorybook.org/reader.php?id=1938) | anansi | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0008](http://storybookscanada.ca/stories/en/0008) | [What are you doing?](http://africanstorybook.org/reader.php?id=7292) | what | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0009](http://storybookscanada.ca/stories/en/0009) | [Where is my cat?](http://africanstorybook.org/reader.php?id=1825) | where | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0027](http://storybookscanada.ca/stories/en/0027) | [Decision](http://africanstorybook.org/reader.php?id=13304) | decision | [CC BY](https://creativecommons.org/licenses/by/4.0/)
[0030](http://storybookscanada.ca/stories/en/0030) | [Feelings](http://africanstorybook.org/reader.php?id=2884) | feelings | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0052](http://storybookscanada.ca/stories/en/0052) | [Simbegwire](http://africanstorybook.org/reader.php?id=7068) | simbegwire | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0066](http://storybookscanada.ca/stories/en/0066) | [Nozibele and the three hairs](http://africanstorybook.org/reader.php?id=1880) | nozibele | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0067](http://storybookscanada.ca/stories/en/0067) | [Cooking](http://africanstorybook.org/reader.php?id=2795) | cooking | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0072](http://storybookscanada.ca/stories/en/0072) | [The Honeyguide's revenge](http://africanstorybook.org/reader.php?id=2099) | honeyguide | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0087](http://storybookscanada.ca/stories/en/0087) | [I like to read!](http://africanstorybook.org/reader.php?id=10547) | read | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0089](http://storybookscanada.ca/stories/en/0089) | [Khalai talks to plants](http://africanstorybook.org/reader.php?id=13545) | khalai | [CC BY](https://creativecommons.org/licenses/by/4.0/)
[0095](http://storybookscanada.ca/stories/en/0095) | [Zama is great!](http://africanstorybook.org/reader.php?id=9984) | zama | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0110](http://storybookscanada.ca/stories/en/0110) | [A Tiny Seed: The Story of Wangari Maathai](http://africanstorybook.org/reader.php?id=9809) | wangari | [CC BY](https://creativecommons.org/licenses/by/4.0/)
[0111](http://storybookscanada.ca/stories/en/0111) | [Why hippos have no hair](http://africanstorybook.org/reader.php?id=6160) | hippos | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0112](http://storybookscanada.ca/stories/en/0112) | [My body](http://africanstorybook.org/reader.php?id=1790) | body | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0120](http://storybookscanada.ca/stories/en/0120) | [Hair](http://africanstorybook.org/reader.php?id=1746) | hair | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0129](http://storybookscanada.ca/stories/en/0129) | [Lazy little brother](http://africanstorybook.org/reader.php?id=2896) | lazy | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0141](http://storybookscanada.ca/stories/en/0141) | [Chicken and Millipede](http://africanstorybook.org/reader.php?id=9094) | chicken | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0156](http://storybookscanada.ca/stories/en/0156) | [The hungry crocodile](http://africanstorybook.org/reader.php?id=7043) | hungry | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0158](http://storybookscanada.ca/stories/en/0158) | [Hen and Eagle](http://africanstorybook.org/reader.php?id=2084) | hen | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0201](http://storybookscanada.ca/stories/en/0201) | [Donkey Child](http://africanstorybook.org/reader.php?id=15028) | donkey | [CC BY](https://creativecommons.org/licenses/by/4.0/)
[0210](http://storybookscanada.ca/stories/en/0210) | [Tingi and the Cows](http://africanstorybook.org/reader.php?id=7441) | tingi | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0231](http://storybookscanada.ca/stories/en/0231) | [Weather book](http://africanstorybook.org/reader.php?id=1861) | weather | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0234](http://storybookscanada.ca/stories/en/0234) | [Andiswa Soccer Star](http://africanstorybook.org/reader.php?id=5283) | andiswa | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0243](http://storybookscanada.ca/stories/en/0243) | [Holidays with grandmother](http://africanstorybook.org/reader.php?id=12084) | holidays | [CC BY](https://creativecommons.org/licenses/by/4.0/)
[0262](http://storybookscanada.ca/stories/en/0262) | [Magozwe](http://africanstorybook.org/reader.php?id=13213) | magozwe | [CC BY](https://creativecommons.org/licenses/by/4.0/)
[0271](http://storybookscanada.ca/stories/en/0271) | [Two](http://africanstorybook.org/reader.php?id=3072) | two | [CC BY-NC](https://creativecommons.org/licenses/by-nc/3.0/)
[0291](http://storybookscanada.ca/stories/en/0291) | [What Vusi's sister said](http://africanstorybook.org/reader.php?id=6895) | vusi | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0294](http://storybookscanada.ca/stories/en/0294) | [Grandma's bananas](http://africanstorybook.org/reader.php?id=2094) | grandma | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0296](http://storybookscanada.ca/stories/en/0296) | [Tom the banana seller](http://africanstorybook.org/reader.php?id=13627) | tom | [CC BY](https://creativecommons.org/licenses/by/4.0/)
[0302](http://storybookscanada.ca/stories/en/0302) | [Fire](http://africanstorybook.org/reader.php?id=8565) | fire | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0315](http://storybookscanada.ca/stories/en/0315) | [Sakima's song](http://africanstorybook.org/reader.php?id=13244) | sakima | [CC BY](https://creativecommons.org/licenses/by/4.0/)
[0324](http://storybookscanada.ca/stories/en/0324) | [The day I left home for the city](http://africanstorybook.org/reader.php?id=15029) | city | [CC BY](https://creativecommons.org/licenses/by/4.0/)
[0327](http://storybookscanada.ca/stories/en/0327) | [Counting animals](http://africanstorybook.org/reader.php?id=9671) | counting | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0337](http://storybookscanada.ca/stories/en/0337) | [Children of wax](http://africanstorybook.org/reader.php?id=2181) | wax | [CC BY](https://creativecommons.org/licenses/by/3.0/)
[0342](http://storybookscanada.ca/stories/en/0342) | [Punishment](http://africanstorybook.org/reader.php?id=11989) | punishment | [CC BY](https://creativecommons.org/licenses/by/3.0/)

## Acknowledgements

All story content has been derived from the [African Storybook](http://africanstorybook.org).

All recordings done at UBC Studios and mixed and post-processed by Craig Carpenter of [Carpenter Sound Services](https://craigjcarpenter.wixsite.com/website).

## License

The audio of each story is released under the same Creative Commons license as that of the original text (see the [table of licenses](#stories) for details). Please note that different licenses (either CC BY or CC BY-NC) and license versions (either 3.0 or 4.0) apply to each story.
