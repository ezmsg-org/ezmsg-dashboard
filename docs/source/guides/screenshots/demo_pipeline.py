"""Demo graph for documentation screenshots: synthetic EEG -> band-pass -> band power."""
import ezmsg.core as ez
from ezmsg.sigproc.spectrum import Spectrum, SpectrumSettings
from ezmsg.sigproc.window import Window, WindowSettings
from ezmsg.sigproc.butterworthfilter import ButterworthFilter, ButterworthFilterSettings
from ezmsg.simbiophys.eeg import EEGSynth, EEGSynthSettings


class Pipeline(ez.Collection):
    SOURCE = EEGSynth(EEGSynthSettings(fs=500.0, n_time=50, n_ch=16, alpha_freq=10.0))
    BANDPASS = ButterworthFilter(ButterworthFilterSettings(axis="time", order=4, cuton=1.0, cutoff=40.0))
    WINDOW = Window(WindowSettings(axis="time", window_dur=1.0, window_shift=0.1, zero_pad_until="input"))
    SPECTRUM = Spectrum(SpectrumSettings(axis="time"))

    def network(self) -> ez.NetworkDefinition:
        return (
            (self.SOURCE.OUTPUT_SIGNAL, self.BANDPASS.INPUT_SIGNAL),
            (self.BANDPASS.OUTPUT_SIGNAL, self.WINDOW.INPUT_SIGNAL),
            (self.WINDOW.OUTPUT_SIGNAL, self.SPECTRUM.INPUT_SIGNAL),
        )

    def process_components(self):
        return (self.SOURCE, self.BANDPASS, self.SPECTRUM)


if __name__ == "__main__":
    ez.run(PIPELINE=Pipeline(), graph_address=("127.0.0.1", 25990))
